// Wire format on the DataChannel (ordered, reliable), both directions:
//   text "req:{id,url,headers}"                  ask the other side to fetch a URL
//   text "res:{id,status,url,headers}"           response head
//   bin  [u32 id][<= 16 KiB body bytes]          response body frames
//   text "fin:{id}" | "err:{id,message}"         end of response | failure
const CHUNK = 16 * 1024 - 4;
const MAX = 32 << 20;
const ALLOW = new Set(['accept', 'accept-language', 'range']);

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

// Every peer can serve (host) and request (client). Returns { fetch(url, headers) }.
export function attach(peer, opts = {}) {
  const { enabled = () => true, onlog = () => {}, onhello = () => {}, build = '?' } = opts;
  const pending = new Map();
  let n = 0;
  let remote = null; // peer's last hello
  const say = (op, m) => peer.dc.send(`${op}:${JSON.stringify(m)}`);
  // Handshake: lets each side fail fast when the other runs old code or is not serving.
  const hello = () => peer.dc?.readyState === 'open' && say('hello', { build, serving: enabled() });
  peer.onopen = hello;

  async function serve(r) {
    const why = enabled() ? blocked(r.url) : 'host disabled';
    if (why) {
      onlog(`deny ${r.url}: ${why}`);
      return say('err', { id: r.id, message: why });
    }
    onlog(`GET ${r.url}`);
    try {
      const headers = Object.fromEntries(
        Object.entries(r.headers ?? {}).filter(([k]) => ALLOW.has(k.toLowerCase())));
      const res = await fetch(r.url, { headers, credentials: 'omit', cache: 'no-store' });
      const final = res.url || r.url;
      const why2 = blocked(final); // redirects are followed, so re-check the final target
      if (why2) throw new Error(`redirect to ${why2}`);
      say('res', { id: r.id, status: res.status, url: final, headers: [...res.headers] });
      const rd = res.body?.getReader();
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
      say('err', { id: r.id, message: e.message });
    }
  }

  peer.onctl = (op, arg) => {
    const m = JSON.parse(arg);
    if (op === 'hello') { remote = m; onhello(m); return; }
    if (op === 'req') return void serve(m).catch(onlog);
    const p = pending.get(m.id);
    if (!p) return;
    if (op === 'res') p.head = m;
    else if (op === 'fin') { pending.delete(m.id); p.ok({ ...p.head, body: new Blob(p.chunks) }); }
    else if (op === 'err') { pending.delete(m.id); p.fail(new Error(m.message)); }
  };
  peer.onbin = (buf) => pending.get(new DataView(buf).getUint32(0))?.chunks.push(buf.slice(4));

  return {
    hello,
    fetch: (url, headers) => new Promise((ok, fail) => {
      if (peer.dc?.readyState !== 'open') {
        return fail(new Error('not connected to a peer yet: both sides Connect, one Offers (see log)'));
      }
      if (!remote) return fail(new Error('no hello from peer: old code? reload extension + tabs'));
      if (!remote.serving) return fail(new Error('peer is not serving: tick "serve requests"'));
      const id = 2 * ++n + (peer.initiator ? 1 : 0); // initiator odd, other side even
      pending.set(id, { chunks: [], ok, fail });
      say('req', { id, url, headers });
      setTimeout(() => pending.delete(id) && fail(new Error('timeout')), 30000)?.unref?.();
    }),
  };
}
