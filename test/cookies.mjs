// Run: node test/cookies.mjs
import assert from 'node:assert/strict';
import { Jar } from '../src/cookies.js';

let t = 1e12;
const jar = new Jar(() => t);
const H = (u) => jar.header(u);

// host-only vs Domain, path scoping, replace
jar.store('https://www.example.com/a/b', ['sid=1; Path=/', 'pref=x; Domain=example.com; Path=/a', 'hostonly=y']);
assert.deepEqual(H('https://www.example.com/a/b').split('; ').sort(), ['hostonly=y', 'pref=x', 'sid=1']);
assert.deepEqual(H('https://www.example.com/other').split('; ').sort(), ['sid=1'], 'path scoping');
assert.equal(H('https://shop.example.com/a/'), 'pref=x', 'Domain cookie reaches subdomains, host-only does not');
assert.equal(H('https://evil.com/a/'), '');
jar.store('https://www.example.com/', ['sid=2; Path=/']);
assert.ok(H('https://www.example.com/x').includes('sid=2') && !H('https://www.example.com/x').includes('sid=1'));

// Domain must match the host; Secure only over https; Max-Age=0 and Expires delete
jar.store('https://a.com/', ['x=1; Domain=b.com', 'y=1; Secure']);
assert.equal(H('https://a.com/'), 'y=1');
assert.equal(H('http://a.com/'), '', 'Secure cookie is not sent over http');
jar.store('http://a.com/', ['z=1; Secure']);
assert.ok(!H('https://a.com/').includes('z='), 'Secure cookie from http is rejected');
jar.store('https://a.com/', ['y=; Max-Age=0']);
assert.equal(H('https://a.com/'), '');
jar.store('https://a.com/', ['e=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'k=1; Max-Age=10']);
assert.equal(H('https://a.com/'), 'k=1');
t += 11000;
assert.equal(H('https://a.com/'), '', 'expired');

// values with = and longest path first
jar.store('https://p.com/a/b/c', ['t=a=b=c; Path=/', 'u=1; Path=/a/b']);
assert.equal(H('https://p.com/a/b/c'), 'u=1; t=a=b=c');
assert.equal(H('https://p.com/a/bc'), 't=a=b=c', 'Path=/a/b must not match /a/bc');
console.log('cookies ok');
