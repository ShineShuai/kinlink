// Run: node test/relay.mjs   (no network; a medium that loses, duplicates and reorders)
import assert from 'node:assert/strict';

globalThis.crypto ??= (await import('node:crypto')).webcrypto;
globalThis.MessageEvent ??= class extends Event {
  constructor(t, i) { super(t); this.data = i?.data; }
};
const { derive, newSecret } = await import('../src/crypto.js');
const { RelayChannel, relayFallback } = await import('../src/relay.js');
const { Peer } = await import('../src/p2p.js');
const { attach } = await import('../src/proxy.js');
const { SignalingAdapter } = await import('../src/signaling.js');

const rng = (a) => () => { // mulberry32: reproducible "random" loss
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const keep = setInterval(() => {}, 1000); // relay timers are unref'd: keep the loop alive
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => {
  for (let t = 0; !f(); t += 5) { if (t > ms) throw new Error(`timeout: ${f}`); await sleep(5); }
};

class Lossy extends SignalingAdapter { // one end of a bad medium
  constructor(rand, loss) { super(); Object.assign(this, { rand, loss, to: [] }); }
  async send(text) {
    for (const o of this.to) {
      if (this.rand() < this.loss) continue;
      for (let n = this.rand() < 0.25 ? 2 : 1; n--;) {
        setTimeout(() => o.emit(text), this.rand() * 15);
      }
    }
  }
}
const medium = (seed, loss) => {
  const rand = rng(seed);
  const [a, b] = [new Lossy(rand, loss), new Lossy(rand, loss)];
  a.to = [b];
  b.to = [a];
  return [a, b];
};
const FAST = { tickMs: 10, rtoMs: 30 };
const { relayKey } = await derive(newSecret());
const mk = (inner, opts = {}) => new RelayChannel(inner, relayKey, { ...FAST, ...opts });
const bytes = (n, k) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + k) & 255);

// Both orders of start; 30% loss, duplicates, reordering. Text and binary, all sizes, in order.
for (const bFirst of [false, true]) {
  const [ma, mb] = medium(bFirst ? 2 : 1, 0.25);
  const a = mk(ma);
  const b = mk(mb);
  const got = [];
  b.onmessage = (e) => got.push(e.data);
  let woke = 0;
  b.onwake = () => { woke++; b.activate(); }; // what relayFallback does
  if (bFirst) b.activate();
  a.activate();
  await until(() => a.readyState === 'open' && b.readyState === 'open');
  assert.equal(woke, bFirst ? 0 : 1);
  const sizes = [0, 1, 8191, 8192, 8193, 100000];
  const text = (n, i) => `t${i}:${'é€😀'.repeat(n / 8 | 0)}`;
  const sent = sizes.map((n, i) => (i % 2 ? bytes(n, i) : text(n, i)));
  for (const m of sent) a.send(m);
  await until(() => got.length === sent.length);
  sent.forEach((m, i) => {
    if (typeof m === 'string') assert.equal(got[i], m, `text ${i}`);
    else assert.deepEqual(new Uint8Array(got[i]), m, `binary ${i}`);
  });
  await until(() => a.bufferedAmount === 0 && a.flight.size === 0);
  b.send('back'); // and the other direction
  const back = new Promise((r) => { a.onmessage = (e) => r(e.data); });
  assert.equal(await back, 'back');
  a.close();
  b.close();
}

// Backpressure: bufferedamountlow fires once the receiver has acked below the threshold.
{
  const [ma, mb] = medium(3, 0);
  const a = mk(ma);
  const b = mk(mb);
  b.onwake = () => b.activate();
  a.activate();
  await until(() => a.readyState === 'open');
  let low = 0;
  a.bufferedAmountLowThreshold = 20000;
  a.addEventListener('bufferedamountlow', () => low++);
  a.send(bytes(200000, 1));
  assert.ok(a.bufferedAmount > 150000);
  await until(() => low > 0);
  await until(() => a.bufferedAmount === 0);
  assert.equal(low, 1);
  a.close();
  b.close();
}

// Foreign key / garbage: ignored, never opens, gives up after openMs.
{
  const [ma, mb] = medium(4, 0);
  const a = mk(ma, { openMs: 150 });
  const other = new RelayChannel(mb, (await derive(newSecret())).relayKey, FAST);
  other.activate();
  mb.send('garbage');
  a.activate();
  const closed = new Promise((r) => { a.onclose = r; });
  await closed;
  assert.equal(a.readyState, 'closed');
  assert.equal(other.readyState, 'connecting');
  other.close();
}

// Peer restart: a new channel (new session id) on one end; the other end re-opens and works.
{
  const [ma, mb] = medium(5, 0.1);
  const a = mk(ma);
  let b = mk(mb);
  b.onwake = () => b.activate();
  let opens = 0;
  a.onopen = () => opens++;
  a.activate();
  await until(() => a.readyState === 'open' && b.readyState === 'open');
  b.close();
  const mb2 = new Lossy(rng(9), 0.1);
  mb2.to = [ma];
  ma.to = [mb2];
  b = mk(mb2);
  b.activate();
  const got = [];
  b.onmessage = (e) => got.push(e.data);
  await until(() => opens === 2 && b.readyState === 'open');
  a.send('after restart');
  await until(() => got.length === 1);
  assert.equal(got[0], 'after restart');
  a.close();
  b.close();
}

// Retransmit exhaustion closes the channel: the peer vanished after open.
{
  const [ma, mb] = medium(6, 0);
  const a = mk(ma, { rtoMs: 2 });
  const b = mk(mb);
  b.onwake = () => b.activate();
  a.activate();
  await until(() => a.readyState === 'open' && b.readyState === 'open');
  ma.to = [];
  mb.to = [];
  const closed = new Promise((r) => { a.onclose = r; });
  a.send('into the void');
  await closed;
  b.close();
}

// relayFallback: triggers, wake-up by the peer, late direct channel does not take over.
class FakePC extends EventTarget {
  connectionState = 'new';
  iceGatheringState = 'complete';
  createDataChannel() { return {}; }
  set(st) { this.connectionState = st; this.dispatchEvent(new Event('connectionstatechange')); }
}
globalThis.RTCPeerConnection = FakePC;
const peerOn = () => Object.assign(new Peer(new SignalingAdapter()), { onlog() {} });
{
  const [ma, mb] = medium(7, 0);
  const [pa, pb] = [peerOn(), peerOn()];
  const logs = [];
  const opt = (who) => ({ after: 40, onlog: (l) => logs.push(`${who} ${l}`), ...FAST });
  const fa = relayFallback(pa, ma, relayKey, opt('a'));
  const fb = relayFallback(pb, mb, relayKey, opt('b'));
  pa.pc.set('connecting');
  await sleep(10);
  assert.ok(!pa.dc, 'not before the timeout');
  pa.pc.set('connected'); // direct path came up in time: no relay
  await sleep(80);
  assert.ok(!fa.chan.active && !pa.dc);
  pa.pc.set('failed'); // ... and later lost
  assert.ok(fa.chan.active && pa.dc === fa.chan, logs.join('|'));
  await until(() => fb.chan.active && pb.dc === fb.chan && pa.dc.readyState === 'open');
  assert.ok(logs.some((l) => /^b relay: peer started it/.test(l)), logs.join('|'));
  // a direct channel that opens late is wired but not used for sending
  const late = {};
  pa.wire(late);
  assert.equal(pa.dc, fa.chan);
  assert.equal(typeof late.onmessage, 'function');
  // the proxy protocol on top: GET with a 100 KB body, POST with a body bigger than the window
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(init.body?.length);
    return new Response(bytes(100000, 5));
  };
  pa.initiator = true;
  const client = attach(pa, { enabled: () => false, helloMs: 20 });
  attach(pb, { helloMs: 20, build: 'b' });
  pa.onopen();
  pb.onopen();
  await sleep(50);
  const r = await client.fetch('https://example.com/big');
  assert.equal(r.status, 200);
  assert.deepEqual(new Uint8Array(await r.body.arrayBuffer()), bytes(100000, 5));
  const r2 = await client.fetch('https://example.com/post', { 'content-type': 'x/y' },
    { method: 'POST', body: bytes(140000, 3).buffer });
  assert.equal(r2.status, 200);
  assert.equal(seen[1], 140000);
  fa.stop();
  fb.stop();
}

// Peer starts the relay first (its OPEN reaches a side whose own timer has not fired).
{
  const [ma, mb] = medium(8, 0);
  const [pa, pb] = [peerOn(), peerOn()];
  const fa = relayFallback(pa, ma, relayKey, { after: 0, ...FAST });
  const fb = relayFallback(pb, mb, relayKey, { after: 60000, ...FAST });
  assert.ok(fa.chan.active, 'after: 0 starts at once');
  await until(() => fb.chan.active && fb.chan.readyState === 'open');
  fa.stop();
  fb.stop();
}
clearInterval(keep);
console.log('relay ok');
