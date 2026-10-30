// Wire format on the DataChannel (ordered, reliable), both directions:
//   text "req:{id,url,method,headers,cookie,referer,origin,body(base64)}"  fetch ONE hop (GET/POST)
//   text "res:{id,status,url,headers,cookies,location,enc}"  response head; redirects are not
//        followed; enc "gzip": the body frames are gzip of the body (asked for by req.ae)
//   bin  [u32 id][<= 16 KiB body bytes]          response body frames
//   text "fin:{id}" | "err:{id,message}"         end of response | failure
const CHUNK = 16 * 1024 - 4;
const MAX = 32 << 20;
const IDLE = 30000; // a request fails after this long without a byte from the peer ...
const IDLE_RELAY = 90000; // ... longer on the broker relay (slow, bursty)
const LIMIT = 10 * 60000; // ... and after this long in any case
const MAX_BODY = 150 * 1024; // a request is one DataChannel message (limit 256 KiB with base64)
const ALLOW = new Set(['accept', 'accept-language', 'range', 'content-type', 'if-none-match',
  'if-modified-since']);
// Text-like bodies compress to a third or less; images, video and woff/woff2 already are.
const ZIP = new RegExp('^(text/|application/([\\w.+-]*json|(x-)?javascript|ecmascript|[\\w.+-]*xml'
  + '|wasm)|image/svg\\+xml|font/(ttf|otf)|application/(x-font-ttf|vnd\\.ms-fontobject))', 'i');
export function zippable(headers = []) {
  const get = (n) => headers.find(([k]) => k === n)?.[1];
  const len = Number(get('content-length'));
  if (!ZIP.test(get('content-type') ?? '')) return false;
  return get('content-encoding') || !(len < 200); // tiny bodies stay as they are
}
const canZip = typeof CompressionStream !== 'undefined'
  && typeof DecompressionStream !== 'undefined';

// Inverse of the Host's gzip, with the same size limit as an uncompressed body (no zip bombs).
export async function gunzip(blob, max = MAX) {
  const rd = blob.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) return new Blob(parts);
    if ((total += value.length) > max) {
      rd.cancel().catch(() => {});
      throw new Error('too large');
    }
    parts.push(value);
  }
}
export const toB64 = (buf) => {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
  return btoa(s);
};
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Default Host executor: plain fetch, follows redirects, no cookies. The extension replaces it
// (src/host-ext.js) with one that does a single hop with Cookie/Referer/Origin and Set-Cookie.
const defaultExec = async ({ url, method, headers, body }) => {
  const res = await fetch(url, { method, headers, body, credentials: 'omit', cache: 'no-store' });
  return { status: res.status, url: res.url || url, headers: [...res.headers], body: res.body };
};

// SSRF guard for the host side. Known gap: DNS names that resolve to private IPs.
export function blocked(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return 'bad url'; }
  if (!['http:', 'https:'].includes(u.protocol)) return 'scheme';
  if (u.port && !['80', '443'].includes(u.port)) return 'port';
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (/(^localhost|\.localhost|\.local|\.internal)$/.test(h)) return 'local name';
  if (h.includes(':')) return /^(::1?$|f[cd]|fe[89ab]|::ffff:)/.test(h) ? 'private ipv6' : null;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const [a, b] = m.slice(1).map(Number);
  const priv = a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b < 128);
  return priv ? 'private ipv4' : null;
}

// Every peer can serve (host) and request (client). Returns { fetch(url, headers, opts) }.
export function attach(peer, opts = {}) {
  const { enabled = () => true, onlog = () => {}, onhello = () => {}, build = '?' } = opts;
  const { helloMs = 500, helloMax = 20, exec = defaultExec } = opts;
  const { idleMs = IDLE, idleRelayMs = IDLE_RELAY, limitMs = LIMIT, watchMs = 1000 } = opts;
  const pending = new Map();
  let n = 0;
  let remote = null; // peer's last hello
  const say = (op, m) => peer.dc.send(`${op}:${JSON.stringify(m)}`);
  // Handshake: lets each side fail fast when the other runs old code or is not serving.
  const hello = (reply = false) => peer.dc?.readyState === 'open'
    && say('hello', { build, serving: enabled(), reply, ...opts.hello?.() });
  // A hello sent while the other side's channel is still opening can get lost: repeat it until
  // the other side's hello arrives. Replies (reply: true) are not answered again.
  peer.onopen = () => {
    let tries = 0;
    hello();
    const t = setInterval(() => {
      if (remote || ++tries > helloMax || peer.dc?.readyState !== 'open') clearInterval(t); else hello();
    }, helloMs);
    t.unref?.();
  };

  async function serve(r) {
    const method = r.method ?? 'GET';
    let why = blocked(r.url);
    if (!['GET', 'POST'].includes(method)) why = 'method';
    if (!enabled()) why = 'host disabled';
    if (why) {
      onlog(`deny ${r.url}: ${why}`);
      return say('err', { id: r.id, message: why });
    }
    onlog(`${method} ${r.url}`);
    try {
      const headers = Object.fromEntries(
        Object.entries(r.headers ?? {}).filter(([k]) => ALLOW.has(k.toLowerCase())));
      const out = await exec({
        url: r.url, method, headers, cookie: r.cookie, referer: r.referer, origin: r.origin,
        body: r.body ? fromB64(r.body) : undefined,
      });
      const why2 = blocked(out.url); // a followed redirect (default executor) lands elsewhere
      if (why2) throw new Error(`redirect to ${why2}`);
      if (!(out.status >= 100 && out.status <= 599)) throw new Error(`bad status ${out.status}`);
      onlog(`${out.status} ${r.url}${out.location ? ` -> ${out.location}` : ''}`);
      const zip = canZip && out.body && r.ae?.includes('gzip') && zippable(out.headers);
      say('res', {
        id: r.id, status: out.status, url: out.url, headers: out.headers,
        cookies: out.setCookies, location: out.location, enc: zip ? 'gzip' : undefined,
      });
      let raw = 0; // the limit counts the body itself, not its gzip
      const cap = new TransformStream({ transform(ch, c) {
        if ((raw += ch.length) > MAX) c.error(new Error('too large')); else c.enqueue(ch);
      } });
      const rd = (zip ? out.body.pipeThrough(cap).pipeThrough(new CompressionStream('gzip'))
        : out.body)?.getReader();
      let total = 0;
      while (rd) {
        const { done, value } = await rd.read();
        if (done) break;
        if ((total += value.length) > MAX) { rd.cancel(); throw new Error('too large'); }
        for (let i = 0; i < value.length; i += CHUNK) {
          const part = value.subarray(i, i + CHUNK);
          const frame = new Uint8Array(4 + part.length);
          new DataView(frame.buffer).setUint32(0, r.id);
          frame.set(part, 4);
          await peer.tx(frame);
        }
      }
      say('fin', { id: r.id });
    } catch (e) {
      onlog(`fail ${r.url}: ${e.message}`);
      say('err', { id: r.id, message: e.message });
    }
  }

  peer.onctl = (op, arg) => {
    const m = JSON.parse(arg);
    if (op === 'hello') {
      remote = m;
      onhello(m);
      if (!m.reply) hello(true); // the sender may not have heard us yet
      return;
    }
    if (op === 'req') return void serve(m).catch(onlog);
    const p = pending.get(m.id);
    if (!p) return;
    p.at = Date.now();
    if (op === 'res') p.head = m;
    else if (op === 'fin') {
      pending.delete(m.id);
      const body = new Blob(p.chunks);
      if (p.head?.enc === 'gzip') {
        gunzip(body).then((b) => p.ok({ ...p.head, body: b }), p.fail);
      } else {
        p.ok({ ...p.head, body });
      }
    }
    else if (op === 'err') { pending.delete(m.id); p.fail(new Error(m.message)); }
  };
  peer.onbin = (buf) => {
    const p = pending.get(new DataView(buf).getUint32(0));
    if (!p) return;
    p.at = Date.now();
    p.chunks.push(buf.slice(4));
  };
  // Fails a request that got nothing for a while (not one that is slow but alive).
  const watch = (id) => {
    const t = setInterval(() => {
      const p = pending.get(id);
      const now = Date.now();
      const idle = peer.dc?.relay && !peer.dc.useAlt ? idleRelayMs : idleMs;
      if (!p) return clearInterval(t);
      if (now - p.at < idle && now - p.t0 < limitMs) return undefined;
      clearInterval(t);
      pending.delete(id);
      return p.fail(new Error('timeout'));
    }, watchMs);
  };

  return {
    hello,
    info: () => remote, // the peer's last hello: { build, serving, remote? }
    // opts: { method, body (ArrayBuffer), cookie, referer, origin }
    fetch: (url, headers, opts = {}) => new Promise((ok, fail) => {
      if (peer.dc?.readyState !== 'open') {
        const link = peer.pc?.connectionState ?? 'none';
        return fail(new Error(`not connected to a peer yet (link: ${link}); see the log for ice/signaling`));
      }
      if (!remote) return fail(new Error('no hello from peer: old code? reload extension + tabs'));
      if (!remote.serving) {
        return fail(new Error('the host is not serving: set "Serve requests" on the host'));
      }
      const id = 2 * ++n + (peer.initiator ? 1 : 0); // initiator odd, other side even
      const { body, ...rest } = opts;
      if (body?.byteLength > MAX_BODY) return fail(new Error('request body too large'));
      pending.set(id, { chunks: [], ok, fail, t0: Date.now(), at: Date.now() });
      const ae = canZip ? 'gzip' : undefined; // the Host may compress text bodies
      const b64 = body?.byteLength ? toB64(body) : undefined;
      say('req', { id, url, headers, ...rest, ae, body: b64 });
      watch(id);
    }),
  };
}
