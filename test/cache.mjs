// Run: node test/cache.mjs   (the Client's HTTP cache against a fake network and a fake clock)
import assert from 'node:assert/strict';
import { HttpCache, lifetime } from '../src/cache.js';
import { browser } from '../src/browse.js';

let t = 1e9;
const mk = (opts = {}) => new HttpCache({ now: () => t, ...opts });
const res = (status, headers, text = 'body', extra = {}) => ({
  status, url: 'https://a.com/x', headers: Object.entries(headers), cookies: [],
  body: new Blob([text]), ...extra,
});
// A fake network: answers from `site`, remembers every request's headers.
const net = (site) => {
  const seen = [];
  const call = (cache, url = 'https://a.com/x', headers = {}, opts = {}) => cache.fetch(
    url, headers, opts, async (h) => { seen.push(h); return site(h, url, opts); });
  return { seen, call };
};

assert.equal(lifetime([['cache-control', 'public, max-age=60']]), 60000);
assert.equal(lifetime([['cache-control', 'max-age=60'], ['age', '45']]), 15000);
assert.equal(lifetime([['cache-control', 'no-cache, max-age=60']]), 0);
assert.equal(lifetime([['cache-control', 's-maxage=60']]), 0, 'private cache: no shared lifetime');
assert.equal(lifetime([['expires', new Date(t + 5000).toUTCString()],
  ['date', new Date(t).toUTCString()]]), 5000);
assert.equal(lifetime([]), 0, 'no heuristics');

// fresh: no second request; stale: a new one
{
  const c = mk();
  const n = net(() => res(200, { 'cache-control': 'max-age=60' }));
  const a = await n.call(c);
  assert.equal(await (await n.call(c)).body.text(), 'body');
  assert.equal(n.seen.length, 1, 'second answer from the cache');
  assert.equal(a.cached, undefined);
  t += 59000;
  assert.equal((await n.call(c)).cached, true);
  t += 2000;
  await n.call(c);
  assert.equal(n.seen.length, 2, 'stale and without validators: fetched again');
}
// revalidation: ETag / Last-Modified go out, a 304 reuses the body and renews the lifetime
{
  const c = mk();
  let version = 'v1';
  const n = net((h) => (h['if-none-match'] === `"${version}"`
    ? res(304, { etag: `"${version}"`, 'cache-control': 'max-age=30' }, '')
    : res(200, { etag: `"${version}"`, 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
      'cache-control': 'max-age=0', 'content-type': 'text/css' }, `css ${version}`)));
  assert.equal(await (await n.call(c)).body.text(), 'css v1');
  const again = await n.call(c);
  assert.equal(await again.body.text(), 'css v1', 'a 304 answers with the stored body');
  assert.equal(again.status, 200);
  assert.equal(n.seen[1]['if-none-match'], '"v1"');
  assert.equal(n.seen[1]['if-modified-since'], 'Mon, 01 Jan 2024 00:00:00 GMT');
  assert.deepEqual(again.headers.find(([k]) => k === 'content-type'), ['content-type', 'text/css']);
  await n.call(c); // max-age=30 from the 304: fresh now
  assert.equal(n.seen.length, 2);
  t += 31000;
  version = 'v2'; // changed on the server: the conditional request gets a 200, replaced
  assert.equal(await (await n.call(c)).body.text(), 'css v2');
  assert.equal(c.stats.revalidated, 1);
  assert.equal(c.entries.size, 1);
}
// not stored
{
  const cases = [
    ['no-store', { 'cache-control': 'no-store, max-age=60' }, 200],
    ['set-cookie', { 'cache-control': 'max-age=60' }, 200, { cookies: ['a=1'] }],
    ['vary cookie', { 'cache-control': 'max-age=60', vary: 'Cookie' }, 200],
    ['vary star', { 'cache-control': 'max-age=60', vary: '*' }, 200],
    ['no lifetime, no validator', {}, 200],
    ['404', { 'cache-control': 'max-age=60' }, 404],
    ['302', { 'cache-control': 'max-age=60' }, 302],
    ['301 without lifetime', { etag: '"x"' }, 301],
  ];
  for (const [name, headers, status, extra] of cases) {
    const c = mk();
    const n = net(() => res(status, headers, 'b', extra));
    await n.call(c);
    await n.call(c);
    assert.equal(n.seen.length, 2, name);
    assert.equal(c.entries.size, 0, name);
  }
  const c = mk({ entry: 10 }); // too big
  const n = net(() => res(200, { 'cache-control': 'max-age=60' }, 'x'.repeat(11)));
  await n.call(c);
  assert.equal(c.entries.size, 0);
}
// permanent redirects with a lifetime are kept (they cost a round trip per hop)
{
  const c = mk();
  const loc = { location: 'https://a.com/y' };
  const n = net(() => res(301, { 'cache-control': 'max-age=3600' }, '', loc));
  await n.call(c);
  const r = await n.call(c);
  assert.equal(n.seen.length, 1);
  assert.deepEqual([r.status, r.location], [301, 'https://a.com/y']);
}
// Range requests and other methods bypass; a POST drops the entry
{
  const c = mk();
  const n = net(() => res(200, { 'cache-control': 'max-age=60' }));
  await n.call(c);
  await n.call(c, 'https://a.com/x', { Range: 'bytes=0-9' });
  assert.equal(n.seen.length, 2, 'range goes to the network');
  assert.equal(c.entries.size, 1);
  await n.call(c, 'https://a.com/x', {}, { method: 'POST' });
  assert.equal(c.entries.size, 0, 'POST drops it');
  await n.call(c);
  await n.call(c);
  assert.equal(n.seen.length, 4);
}
// Vary: a different Accept is another variant; fragments are not part of the key
{
  const c = mk();
  const n = net((h) => res(200, { 'cache-control': 'max-age=60', vary: 'Accept, Accept-Encoding' },
    h.accept));
  const get = async (url, accept) => (await n.call(c, url, accept)).body.text();
  assert.equal(await get('https://a.com/x#a', { accept: 'image/webp' }), 'image/webp');
  assert.equal(await get('https://a.com/x#b', { Accept: 'image/webp' }), 'image/webp');
  assert.equal(n.seen.length, 1);
  assert.equal(await get('https://a.com/x', { accept: 'text/html' }), 'text/html');
  assert.equal(n.seen.length, 2);
}
// least recently used goes first when the budget is exceeded
{
  const c = mk({ max: 25, entry: 25 });
  const n = net((h, url) => res(200, { 'cache-control': 'max-age=60' }, `${url}`.padEnd(10, '.')));
  for (const u of ['a', 'b']) await n.call(c, `https://x/${u}`);
  await n.call(c, 'https://x/a'); // a is the newest now
  await n.call(c, 'https://x/c'); // 30 B > 25: b leaves
  assert.deepEqual([...c.entries.keys()], ['https://x/a', 'https://x/c']);
  assert.ok(c.bytes <= 25);
}
// browse.js: hops, cookies and the cache work together
{
  const c = mk();
  const calls = [];
  const api = { fetch: async (url, headers, opts) => {
    calls.push([url, headers, opts.cookie]);
    if (url === 'https://a.com/') {
      const to = { url, location: 'https://a.com/home' };
      return res(301, { 'cache-control': 'max-age=3600' }, '', to);
    }
    return res(200, { 'cache-control': 'max-age=60' }, 'home', { url, cookies: [] });
  } };
  const b = browser(api, undefined, c);
  assert.equal((await b.fetch('https://a.com/')).url, 'https://a.com/home');
  assert.equal(calls.length, 2);
  assert.equal(await (await b.fetch('https://a.com/')).body.text(), 'home');
  assert.equal(calls.length, 2, 'redirect and page both from the cache');
}
console.log('cache ok');
