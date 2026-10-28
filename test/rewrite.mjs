// Run: node test/rewrite.mjs   (pure string rewriting, no network)
import assert from 'node:assert/strict';
import { proxify, rewriteCss, rewriteHtml } from '../src/rewrite.js';

const R = '/k/~/';
const D = 'https://example.com/dir/p.html';
const html = (s) => rewriteHtml(s, D, R);
const has = (s, sub) => assert.ok(s.includes(sub), `missing ${sub}\n in ${s}`);
const lacks = (s, sub) => assert.ok(!s.includes(sub), `unexpected ${sub}\n in ${s}`);

// URLs
assert.equal(proxify('/x?a=1#f', D, R), `${R}https://example.com/x?a=1#f`);
assert.equal(proxify('//cdn.com/i.png', D, R), `${R}https://cdn.com/i.png`);
assert.equal(proxify('../up.css', D, R), `${R}https://example.com/up.css`);
for (const u of ['#top', 'data:text/plain,a', 'javascript:void(0)', 'mailto:a@b.c', 'blob:x']) {
  assert.equal(proxify(u, D, R), u);
}

// attributes: quoting styles, case, entities
let o = html('<A HREF=\'/x?a=1&amp;b=2\'>l</A><img src=/i.png><a href="rel/p.html">');
has(o, `HREF="${R}https://example.com/x?a=1&amp;b=2"`);
has(o, `src="${R}https://example.com/i.png"`);
has(o, `href="${R}https://example.com/dir/rel/p.html"`);
has(html('<a href="/a?x=1&y=2">'), '/a?x=1&amp;y=2');

// srcset: commas inside URLs, descriptors kept
o = html('<img srcset="a.jpg 1x,w_1,h_2.jpg 2x">');
has(o, `srcset="${R}https://example.com/dir/a.jpg 1x, ${R}https://example.com/dir/w_1,h_2.jpg 2x"`);

// head injection, base, integrity, meta
o = html('<!doctype html><html><head><title>t</title><base href="/b/"></head><img src=x.png>');
assert.ok(o.startsWith('<!doctype html><html><head><script src="/k/rt.js"></script>'), o);
lacks(o, '<base');
has(o, `${R}https://example.com/b/x.png`);
o = html('<script src="/a.js" integrity="sha384-x" crossorigin></script>');
lacks(o, 'integrity');
has(o, `${R}https://example.com/a.js`);
o = html('<head><meta http-equiv="Content-Security-Policy" content="default-src none">'
  + '<meta http-equiv=refresh content="0;url=/e?a=1"></head>');
lacks(o, 'default-src');
has(o, `content="0;url=${R}https://example.com/e?a=1"`);
has(html('<p>no head</p>'), '<script src="/k/rt.js"></script><p>');
assert.ok(html('<!doctype html><p>x').startsWith('<!doctype html><script'));

// script bodies and comments stay untouched; style bodies and attributes are rewritten
o = html('<script>var s = \'<a href="/no">\'</script><!-- <a href="/c"> --><textarea><a href="/t"></textarea>');
has(o, '<script>var s = \'<a href="/no">\'</script>');
has(o, '<!-- <a href="/c"> -->');
has(o, '<textarea><a href="/t"></textarea>');
o = html('<style>a{background:url(/q.png)}</style><i style="background:url(\'/r.png\')">');
has(o, `url("${R}https://example.com/q.png")`);
has(o, `url(&quot;${R}https://example.com/r.png&quot;)`);

// css
const css = rewriteCss('a{b:url(/a.png)}@import "c.css";@import url(d.css);e{f:url(data:image/png;base64,AAA=)}',
  'https://example.com/s/x.css', R);
has(css, `url("${R}https://example.com/a.png")`);
has(css, `@import "${R}https://example.com/s/c.css"`);
has(css, `url("${R}https://example.com/s/d.css")`);
has(css, 'url("data:image/png;base64,AAA=")');
console.log('rewrite ok');
