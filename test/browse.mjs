// Run: node test/browse.mjs   (stub peer API; redirects, cookies, referer/origin)
import assert from 'node:assert/strict';
import { browser } from '../src/browse.js';

const calls = [];
const res = (status, extra = {}) => ({ status, headers: [], body: new Blob(['x']), ...extra });
const make = (script) => browser({
  async fetch(url, headers, opts) {
    calls.push({ url, ...opts });
    return script(url, opts);
  },
});

// consent flow: GET -> 302 consent; POST -> 303 + Set-Cookie -> GET with the cookie -> 200
let b = make((url, o) => {
  if (url === 'https://s.test/') return o.cookie.includes('ok=1') ? res(200) : res(302, { location: '/consent' });
  if (url === 'https://s.test/consent' && o.method === 'POST') {
    return res(303, { location: 'https://s.test/', cookies: ['ok=1; Path=/'] });
  }
  return res(200);
});
let r = await b.fetch('https://s.test/');
assert.equal(new URL(r.url).pathname, '/consent');
r = await b.fetch('https://s.test/consent', { method: 'POST', body: new Uint8Array([1]).buffer,
  referer: 'https://s.test/consent' });
assert.equal(r.status, 200);
assert.equal(r.url, 'https://s.test/');
const post = calls.find((c) => c.method === 'POST');
assert.equal(post.origin, 'https://s.test', 'POST carries the Origin of the page that asked');
assert.equal(calls.at(-1).method, 'GET', '303 turns the POST into a GET');
assert.equal(calls.at(-1).body, undefined);
assert.equal(calls.at(-1).cookie, 'ok=1', 'cookie from the redirecting response is used on the next hop');

// 307 keeps method and body; 301/302 on GET keep GET
calls.length = 0;
b = make((url) => (url.endsWith('/a') ? res(307, { location: '/b' }) : res(200)));
await b.fetch('https://s.test/a', { method: 'POST', body: new Uint8Array([7]).buffer });
assert.equal(calls[1].method, 'POST');
assert.deepEqual([...new Uint8Array(calls[1].body)], [7]);

// referer: full for same origin, origin only cross-origin, none for https -> http downgrade
calls.length = 0;
b = make(() => res(200));
await b.fetch('https://s.test/x', { referer: 'https://s.test/page?q=1#h' });
await b.fetch('https://cdn.test/y', { referer: 'https://s.test/page?q=1' });
await b.fetch('http://plain.test/z', { referer: 'https://s.test/page' });
assert.deepEqual(calls.map((c) => c.referer), ['https://s.test/page?q=1', 'https://s.test/', undefined]);

// loops end
b = make(() => res(302, { location: '/again' }));
await assert.rejects(b.fetch('https://s.test/'), /too many redirects/);
// a 3xx without Location is a normal response
b = make(() => res(304));
assert.equal((await b.fetch('https://s.test/')).status, 304);
console.log('browse ok');
