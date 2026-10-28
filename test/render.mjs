// Run: node test/render.mjs   (peer stubbed, no network)
import assert from 'node:assert/strict';
import { render } from '../src/render.js';

const R = '/k/~/';
const bytes = (s) => new TextEncoder().encode(s).buffer;
const ok = (url, type, body, extra = {}) => async () => ({
  status: 200, url, headers: [['content-type', type]], body, ...extra });
const get = (url, ask, method = 'GET') => render({ url, method, headers: {} }, ask, R);
const text = (r) => r.text();

// HTML: rewritten, re-encoded, origin CSP replaced, hop-by-hop headers dropped
let r = await get('https://example.com/', ok('https://example.com/', 'text/html; charset=utf-8',
  bytes('<img src="/a.png">'), { headers: [['content-type', 'text/html'],
    ['content-security-policy', 'x'], ['content-encoding', 'gzip'], ['set-cookie', 'a=b']] }));
assert.equal(r.status, 200);
assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
assert.equal(r.headers.get('content-encoding'), null);
assert.equal(r.headers.get('set-cookie'), null);
assert.match(await text(r), /<img src="\/k\/~\/https:\/\/example.com\/a.png">/);

// charset from header and from <meta>: GBK bytes for "中文"
const gbk = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]);
const page = (head) => Uint8Array.from([...new TextEncoder().encode(`${head}<p>`), ...gbk]).buffer;
r = await get('https://example.cn/', ok('https://example.cn/', 'text/html; charset=gbk', page('')));
assert.match(await text(r), /中文/);
r = await get('https://example.cn/', ok('https://example.cn/', 'text/html', page('<meta charset=gb2312>')));
assert.match(await text(r), /中文/);

// redirects are surfaced so relative URLs resolve against the final URL; trailing slash is not one
r = await get('http://example.com/a', ok('https://example.com/b', 'text/html', bytes('')));
assert.equal(r.status, 302);
assert.equal(r.headers.get('location'), `${R}https://example.com/b`);
r = await get('https://example.com', ok('https://example.com/', 'text/html', bytes('x')));
assert.equal(r.status, 200);
r = await get('example.com/x', ok('', '', bytes('')));
assert.equal(r.headers.get('location'), `${R}https://example.com/x`);

// css, binary passthrough with range headers, empty statuses
r = await get('https://e.com/s.css', ok('https://e.com/s.css', 'text/css', bytes('a{b:url(i.png)}')));
assert.match(await text(r), /url\("\/k\/~\/https:\/\/e.com\/i.png"\)/);
const bin = Uint8Array.from([0, 255, 1, 254]).buffer;
r = await get('https://e.com/v.mp4', ok('https://e.com/v.mp4', 'video/mp4', bin, {
  status: 206, headers: [['content-type', 'video/mp4'], ['content-range', 'bytes 0-3/9']] }));
assert.equal(r.status, 206);
assert.equal(r.headers.get('content-range'), 'bytes 0-3/9');
assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [0, 255, 1, 254]);
r = await get('https://e.com/n', ok('https://e.com/n', 'text/html', bytes('x'), { status: 204 }));
assert.equal(r.status, 204);
assert.equal(r.body, null);

// failures become pages, never throw; messages are escaped
r = await get('https://e.com/', async () => { throw new Error('deny <b>x</b>'); });
assert.equal(r.status, 502);
assert.ok(!(await text(r)).includes('<b>'));
// POST is passed on with body and referer; other methods are refused
let got;
r = await render({ url: 'https://e.com/form', method: 'POST', headers: { 'content-type': 'text/plain' },
  body: bytes('a=1'), referer: 'https://e.com/page' }, async (url, req) => {
  got = { url, req };
  return { status: 200, url, headers: [['content-type', 'text/plain']], body: bytes('done') };
}, R);
assert.equal(await text(r), 'done');
assert.equal(got.req.method, 'POST');
assert.equal(new TextDecoder().decode(got.req.body), 'a=1');
assert.deepEqual([got.req.referer, got.req.headers['content-type']], ['https://e.com/page', 'text/plain']);
assert.equal((await get('https://e.com/', ok('', '', bytes('')), 'PUT')).status, 501);
assert.equal((await get('ftp://e.com/', ok('', '', bytes('')))).status, 400);
assert.equal((await get('', ok('', '', bytes('')))).status, 400);
console.log('render ok');
