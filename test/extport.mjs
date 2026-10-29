// Run: node test/extport.mjs   (fake runtime ports; the service worker's executor is a stub)
import assert from 'node:assert/strict';
import { execViaPort, servePort } from '../src/ext-port.js';

// Two ends of a runtime Port: JSON only (structured clone is not available between contexts).
const ports = () => {
  const mk = () => {
    const x = { ls: [], dis: [], gone: false };
    x.onMessage = { addListener: (f) => x.ls.push(f) };
    x.onDisconnect = { addListener: (f) => x.dis.push(f) };
    return x;
  };
  const [a, b] = [mk(), mk()];
  const wire = (x, y) => {
    x.postMessage = (m) => {
      if (x.gone || y.gone) throw new Error('port closed');
      const j = JSON.parse(JSON.stringify(m));
      setTimeout(() => y.ls.forEach((f) => f(j)), 0);
    };
    x.disconnect = () => { x.gone = true; setTimeout(() => y.dis.forEach((f) => f()), 0); };
  };
  wire(a, b);
  wire(b, a);
  return [a, b];
};
const stream = (parts) => new ReadableStream({
  start(c) { parts.forEach((p) => c.enqueue(p)); c.close(); },
});
const run = (exec, req) => {
  const [c, s] = ports();
  servePort(s, exec);
  return { s, p: execViaPort(req, () => c) };
};
const bytes = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 3) & 255);
const read = async (rs) => new Uint8Array(await new Response(rs).arrayBuffer());

// head, a body bigger than one chunk, request body and fields arrive intact
{
  let seen;
  const big = bytes(150000);
  const { p } = run(async (q) => {
    seen = q;
    return {
      status: 302, url: q.url, headers: [['a', 'b']], setCookies: ['k=v'], location: '/x',
      body: stream([big.subarray(0, 100000), big.subarray(100000)]),
    };
  }, {
    url: 'https://e.com/', method: 'POST', headers: { a: 'b' }, cookie: 'c=1',
    referer: 'r', origin: 'o', body: bytes(1000),
  });
  const r = await p;
  assert.deepEqual([r.status, r.url, r.headers, r.setCookies, r.location],
    [302, 'https://e.com/', [['a', 'b']], ['k=v'], '/x']);
  assert.deepEqual(await read(r.body), big);
  assert.deepEqual([seen.method, seen.cookie, seen.referer, seen.origin],
    ['POST', 'c=1', 'r', 'o']);
  assert.deepEqual(seen.body, bytes(1000));
  assert.ok(seen.signal instanceof AbortSignal);
}

// null body (redirect hop), executor failure
{
  const hop = async () => ({ status: 303, url: 'u', headers: [], body: null });
  const r = await run(hop, { url: 'u' }).p;
  assert.equal(r.status, 303);
  assert.equal((await read(r.body)).length, 0);
  await assert.rejects(run(async () => { throw new Error('net::ERR_FAILED'); }, { url: 'u' }).p,
    /ERR_FAILED/);
}

// failure in the middle of the body reaches the reader
{
  const bad = new ReadableStream({
    start(c) { c.enqueue(bytes(10)); },
    pull(c) { c.error(new Error('reset')); },
  });
  const exec = async () => ({ status: 200, url: 'u', headers: [], body: bad });
  const r = await run(exec, { url: 'u' }).p;
  await assert.rejects(read(r.body), /reset/);
}

// the reader cancels: the port closes and the worker aborts its fetch
{
  let signal;
  const endless = new ReadableStream({ // like a network stream: data arrives over time
    async pull(c) { await new Promise((r) => setTimeout(r, 1)); c.enqueue(bytes(1000)); },
  });
  const { p } = run(async (q) => {
    signal = q.signal;
    return { status: 200, url: 'u', headers: [], body: endless };
  }, { url: 'u' });
  const r = await p;
  const rd = r.body.getReader();
  await rd.read();
  await rd.cancel();
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(signal.aborted, true);
}

// the worker dies before the head / in the middle: the caller gets an error, not a hang
{
  const { s, p } = run(() => new Promise(() => {}), { url: 'u' });
  setTimeout(() => s.disconnect(), 10);
  await assert.rejects(p, /closed the port/);
  const half = new ReadableStream({ start(c) { c.enqueue(bytes(5)); } });
  const { s: s2, p: p2 } = run(
    async () => ({ status: 200, url: 'u', headers: [], body: half }), { url: 'u' });
  const r = await p2;
  setTimeout(() => s2.disconnect(), 20);
  await assert.rejects(read(r.body), /closed the port/);
}
console.log('extport ok');
