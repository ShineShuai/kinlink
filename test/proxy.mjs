// Run: node test/proxy.mjs   (two fake peers wired back to back, fetch stubbed)
import assert from 'node:assert/strict';
import { Peer } from '../src/p2p.js';
import { attach, blocked } from '../src/proxy.js';

for (const u of ['http://127.0.0.1/', 'http://2130706433/', 'http://10.1.2.3/',
  'http://192.168.0.1/', 'http://[::1]/', 'http://[fd00::1]/', 'http://localhost/',
  'http://x.local/', 'ftp://a.com/', 'http://a.com:8080/', 'http://100.64.0.1/']) {
  assert.ok(blocked(u), u);
}
for (const u of ['https://example.com/', 'http://8.8.8.8/', 'https://a.com:443/x']) {
  assert.equal(blocked(u), null, u);
}

const mk = () => Object.assign(Object.create(Peer.prototype),
  { rx: 0, onlog() {}, dc: { bufferedAmount: 0, readyState: 'open' } });
const [A, B] = [mk(), mk()];
const link = (x, y) => {
  x.dc.send = (d) => queueMicrotask(() => y.onmsg(
    typeof d === 'string' ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)));
};
link(A, B);
link(B, A);
A.initiator = true;

globalThis.fetch = async () => new Response(new Uint8Array(100000).fill(7));
const client = attach(A, { enabled: () => false });
attach(B);
const tick = () => new Promise((r) => setTimeout(r, 0));
A.onopen();
B.onopen();
await tick(); // let hellos arrive

const r = await client.fetch('https://example.com/big');
assert.equal(r.status, 200);
assert.equal(r.body.size, 100000);
assert.ok(new Uint8Array(await r.body.arrayBuffer()).every((v) => v === 7));
await assert.rejects(client.fetch('http://127.0.0.1/'), /private/);
// peer without handshake (old code) and peer that does not serve: fail fast
const pair = (serving) => {
  const [X, Y] = [mk(), mk()];
  link(X, Y);
  link(Y, X);
  const c = attach(X);
  X.onopen();
  if (serving !== undefined) { attach(Y, { enabled: () => serving }); Y.onopen(); }
  return c;
};
const old = pair();
await tick();
await assert.rejects(old.fetch('https://example.com/'), /old code/);
const off = pair(false);
await tick();
await assert.rejects(off.fetch('https://example.com/'), /not serving/);
// the first hellos can get lost while the other side's channel is still opening: retries + replies
{
  const [X, Y] = [mk(), mk()];
  X.initiator = true;
  const raw = (d) => (typeof d === 'string' ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
  let lost = 0;
  X.dc.send = (d) => queueMicrotask(() => Y.onmsg(raw(d)));
  Y.dc.send = (d) => {
    if (typeof d === 'string' && d.startsWith('hello:') && lost++ < 2) return;
    queueMicrotask(() => X.onmsg(raw(d)));
  };
  const c = attach(X, { helloMs: 5 });
  attach(Y, { helloMs: 5 });
  X.onopen();
  Y.onopen();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await c.fetch('https://example.com/')).status, 200);
}
// POST, cookies, referer/origin and the redirect hop all travel through the protocol
{
  const [X, Y] = [mk(), mk()];
  X.initiator = true;
  link(X, Y);
  link(Y, X);
  const seen = [];
  const c = attach(X, { helloMs: 5 });
  attach(Y, { helloMs: 5, exec: async (q) => { // the extension's one-hop executor looks like this
    seen.push(q);
    return { status: 303, url: q.url, headers: [['x', 'y']], body: null,
      setCookies: ['a=1; Path=/'], location: '/next' };
  } });
  X.onopen();
  Y.onopen();
  await new Promise((r) => setTimeout(r, 30));
  const r = await c.fetch('https://example.com/form', { 'content-type': 'text/plain', 'x-evil': '1' },
    { method: 'POST', body: new Uint8Array([1, 2, 3]).buffer, cookie: 'k=v',
      referer: 'https://example.com/', origin: 'https://example.com' });
  assert.equal(r.status, 303);
  assert.equal(r.location, '/next');
  assert.deepEqual(r.cookies, ['a=1; Path=/']);
  assert.equal(seen[0].method, 'POST');
  assert.deepEqual([...seen[0].body], [1, 2, 3]);
  assert.deepEqual([seen[0].cookie, seen[0].referer, seen[0].origin],
    ['k=v', 'https://example.com/', 'https://example.com']);
  assert.deepEqual(seen[0].headers, { 'content-type': 'text/plain' }, 'only allowed headers pass');
  await assert.rejects(c.fetch('https://example.com/', {}, { method: 'PUT' }), /method/);
  await assert.rejects(c.fetch('https://example.com/', {},
    { method: 'POST', body: new ArrayBuffer(200 * 1024) }), /too large/);
  await assert.rejects(c.fetch('http://127.0.0.1/', {}, { method: 'POST' }), /private/);
}
const down = mk();
down.dc.readyState = 'connecting';
await assert.rejects(attach(down).fetch('https://example.com/'), /not connected to a peer yet/);
console.log('proxy ok');
