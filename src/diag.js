// Endpoints are candidates, not a verified list: measuring them is the point of this page.
export const CFG = {
  stun: [
    'stun:stun.l.google.com:19302',
    'stun:stun.cloudflare.com:3478',
    'stun:global.stun.twilio.com:3478',
    'stun:stun.miwifi.com:3478',
    'stun:stun.qq.com:3478',
  ],
  mqtt: [ // signaling brokers; the app uses all that connect, so one blocked broker is fine
    'wss://broker-cn.emqx.io:8084/mqtt',
    'wss://broker.emqx.io:8084/mqtt',
    'wss://test.mosquitto.org:8081',
  ],
  wss: [], // [url, subprotocol?], filled below
  https: [ // opaque no-cors fetch: tests connect/TLS only
    'https://www.baidu.com/',
    'https://www.google.com/generate_204',
    'https://www.cloudflare.com/cdn-cgi/trace',
  ],
  wt: [], // QUIC needs an own WebTransport endpoint, e.g. 'https://host:4433/wt'
};

CFG.wss = [...CFG.mqtt.map((u) => [u, 'mqtt']), ['wss://relay.damus.io'], ['wss://nos.lol']];

const gatherSrflx = (urls, ms, firstOnly) => new Promise((res, rej) => {
  const pc = new RTCPeerConnection({ iceServers: urls.map((u) => ({ urls: u })) });
  const seen = new Set();
  const done = (f, v) => { clearTimeout(t); pc.close(); f(v); };
  const t = setTimeout(() => done(firstOnly ? rej : res, firstOnly
    ? new Error('timeout') : seen), ms);
  pc.createDataChannel('x');
  pc.onicecandidate = ({ candidate: c }) => {
    if (!c) return firstOnly ? done(rej, new Error('no srflx')) : done(res, seen);
    if (c.type !== 'srflx') return;
    seen.add(`${c.address}:${c.port}`);
    if (firstOnly) done(res, [...seen][0]);
  };
  pc.createOffer().then((o) => pc.setLocalDescription(o));
});

// STUN servers that answer here, fastest first (at most `max`). One that never answers (google in
// China) stalls the real connection's gathering, so the Peer only gets responders. Returns as soon
// as `max` answered; none answered: the first two as they are (UDP blocked: nothing helps).
export async function pickStun(urls, ms = 1500, max = 3) {
  const up = [];
  const rows = [];
  await new Promise((done) => {
    if (!urls.length) return done();
    const t = setTimeout(done, ms + 200);
    for (const url of urls) {
      const t0 = performance.now();
      gatherSrflx([url], ms, true).then(() => true, () => false).then((ok) => {
        rows.push({ url, ok, ms: Math.round(performance.now() - t0) });
        if (ok) up.push(url);
        if (up.length >= max || rows.length === urls.length) { clearTimeout(t); done(); }
      });
    }
  });
  return { up: up.length ? up : urls.slice(0, 2), rows, answered: up.length };
}

const wsProbe = (url, proto, ms) => new Promise((res, rej) => {
  const ws = new WebSocket(url, proto);
  const done = (f, v) => { clearTimeout(t); ws.close(); f(v); };
  const t = setTimeout(() => done(rej, new Error('timeout')), ms);
  ws.onopen = () => done(res, ws.protocol || 'open');
  ws.onerror = () => done(rej, new Error('error'));
});

const httpsProbe = async (url, ms) => (await fetch(url, {
  mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(ms),
})).type;

const wtProbe = async (url, ms) => {
  const wt = new WebTransport(url);
  const t = setTimeout(() => wt.close(), ms);
  try { await wt.ready; return 'ready'; } finally { clearTimeout(t); wt.close(); }
};

// Single PC, several STUN servers, one socket: >1 distinct srflx mapping => symmetric-like.
// Heuristic; needs >=2 reachable servers.
const natType = async (urls, ms) => {
  if (urls.length < 2) throw new Error('need >=2 reachable STUN servers');
  const seen = await gatherSrflx(urls, ms, false);
  if (!seen.size) return 'no srflx';
  return seen.size === 1 ? 'EIM (cone-like)' : `EDM (symmetric-like) ${[...seen]}`;
};

export async function runProbes(cfg = CFG, ms = 5000, onresult = () => {}) {
  const out = [];
  const add = async (kind, target, fn) => {
    const t0 = performance.now();
    let r;
    try { r = { ok: true, info: await fn() }; }
    catch (e) { r = { ok: false, err: e.message || String(e) }; }
    r = { kind, target, ms: Math.round(performance.now() - t0), ...r };
    out.push(r);
    onresult(r);
  };
  await Promise.all([
    ...cfg.stun.map((u) => add('stun', u, () => gatherSrflx([u], ms, true))),
    ...cfg.wss.map(([u, p]) => add('wss', u, () => wsProbe(u, p, ms))),
    ...cfg.https.map((u) => add('https', u, () => httpsProbe(u, ms))),
    ...cfg.wt.map((u) => add('wt', u, () => wtProbe(u, ms))),
  ]);
  const up = out.filter((r) => r.kind === 'stun' && r.ok).map((r) => r.target);
  await add('nat', `${up.length} stun`, () => natType(up, ms));
  return out;
}
