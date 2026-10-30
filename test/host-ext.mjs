// Run: node test/host-ext.mjs   (fake chrome.webRequest / declarativeNetRequest and fetch)
import assert from 'node:assert/strict';

const ORIGIN = 'chrome-extension://abc';
const on = {};
const ev = (name) => ({ addListener: (f) => { on[name] = f; } });
globalThis.location = { origin: ORIGIN };
globalThis.chrome = {
  runtime: { id: 'abc' },
  webRequest: { onHeadersReceived: ev('headers'), onBeforeRedirect: ev('redirect') },
  declarativeNetRequest: { updateSessionRules: async () => {} },
};
const { exec } = await import('../src/host-ext.js');

const base = { initiator: ORIGIN, type: 'xmlhttprequest', method: 'GET' };
const headers = (url, statusCode, h) => on.headers({
  ...base, url, statusCode, responseHeaders: Object.entries(h).map(([name, value]) => ({ name, value })) });
const hop = (url, statusCode, redirectUrl) => on.redirect({ ...base, url, statusCode, redirectUrl });
const opaque = { type: 'opaqueredirect', status: 0, headers: new Headers(), body: null };
const run = (url, fetchImpl, fire = () => {}) => {
  globalThis.fetch = async () => { setTimeout(fire, 10); return fetchImpl(); };
  return exec({ url });
};

// plain 200: status and Set-Cookie come from the event, the body from fetch
{
  const url = 'https://a.com/';
  const r = await run(url, () => new Response('hi', { status: 200 }),
    () => headers(url, 200, { 'set-cookie': 'a=1' }));
  assert.deepEqual([r.status, r.setCookies, r.location], [200, ['a=1'], undefined]);
  assert.equal(await new Response(r.body).text(), 'hi');
}

// ordinary redirect: headers event (Location, Set-Cookie) first, then onBeforeRedirect
{
  const url = 'https://a.com/old';
  const r = await run(url, () => opaque, () => {
    headers(url, 302, { location: '/new', 'set-cookie': 'k=v' });
    hop(url, 302, 'https://a.com/new');
  });
  assert.deepEqual([r.status, r.setCookies, r.location, r.body], [302, ['k=v'], '/new', null]);
  const again = await run(url, () => opaque, () => {
    headers(url, 301, { location: '/n2' });
    hop(url, 301, 'https://a.com/n2');
  });
  assert.deepEqual([again.status, again.location], [301, '/n2'], 'no leftover events of the first');
}

// HSTS upgrade seen only by onBeforeRedirect (what Chrome does with extraHeaders): yahoo.de case
{
  const url = 'http://de.yahoo.com/';
  const r = await run(url, () => opaque, () => hop(url, 307, 'https://de.yahoo.com/'));
  assert.deepEqual([r.status, r.location, r.setCookies], [307, 'https://de.yahoo.com/', []]);
}

// no event at all for an http URL: it can only be the upgrade
{
  const r = await run('http://x.com/p?q=1', () => opaque);
  assert.deepEqual([r.status, r.location], [307, 'https://x.com/p?q=1']);
}

// an opaque redirect we know nothing about: an error, never status 0
await assert.rejects(run('https://x.com/', () => opaque), /hidden by the browser/);

// events of other initiators (pages, other extensions) are ignored
{
  const url = 'https://a.com/other';
  const r = await run(url, () => new Response('x', { status: 200 }), () => {
    on.headers({ ...base, initiator: 'https://evil.com', url, statusCode: 500, responseHeaders: [] });
    headers(url, 200, {});
  });
  assert.equal(r.status, 200);
}
console.log('host-ext ok');
