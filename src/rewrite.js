// URL, HTML and CSS rewriting for the rendering layer. Pure functions, no DOM.
// A rendered page lives at <root><real url>, e.g. "/kinlink/~/https://example.com/a?b=1".
// Every URL in it is made absolute and prefixed with root, so the Service Worker sees it.

const SKIP = /^\s*(#|data:|blob:|javascript:|about:|mailto:|tel:)/i;
const ENT = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
const dec = (s) => s.replace(/&(?:(amp|quot|apos|lt|gt)|#(\d+)|#x([\da-f]+));/gi,
  (m, n, d, h) => ENT[n?.toLowerCase()] ?? String.fromCodePoint(d ? +d : parseInt(h, 16)));
const enc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

export function proxify(url, base, root) {
  if (SKIP.test(url)) return url;
  try {
    const u = new URL(url.trim(), base);
    return /^https?:$/.test(u.protocol) ? root + u.href : url;
  } catch { return url; }
}

// "a.jpg 1x, b.jpg 2x": URLs may contain commas, descriptors never do.
function srcset(s, px) {
  const out = [];
  for (let i = 0, m; (m = /^[\s,]*(\S+)/.exec(s.slice(i))); ) {
    i += m[0].length;
    let url = m[1], desc = '';
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    else { desc = /^[^,]*/.exec(s.slice(i))[0]; i += desc.length; }
    out.push(px(url) + desc);
  }
  return out.join(', ');
}

export function rewriteCss(css, base, root) {
  const px = (u) => proxify(u, base, root);
  return css
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi,
      (m, a, b, c) => `url("${px(a ?? b ?? c)}")`)
    .replace(/@import\s+(?:"([^"]*)"|'([^']*)')/gi, (m, a, b) => `@import "${px(a ?? b)}"`);
}

const URL_ATTRS = new Set(['src', 'href', 'action', 'poster', 'formaction', 'data', 'background']);
const ATTR = /([^\s"'<>/=]+)(?:(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
const ATTRS = '((?:"[^"]*"|\'[^\']*\'|[^>"\'])*)';
const TAG = new RegExp(`<!--[\\s\\S]*?-->|<(script|style|textarea|title)\\b${ATTRS}>([\\s\\S]*?)`
  + `<\\/\\1\\s*>|<([a-z][^\\s/>]*)${ATTRS}>`, 'gi');

// Rewrites URLs in markup and injects <script src=root/../rt.js> first in <head>.
export function rewriteHtml(html, docUrl, root) {
  const b = /<base\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html);
  const base = b ? new URL(dec(b[1] ?? b[2] ?? b[3]), docUrl).href : docUrl;
  const px = (u) => proxify(u, base, root);
  const attrs = (s) => s.replace(ATTR, (m, name, eq, val) => {
    const n = name.toLowerCase();
    if (val === undefined) return m;
    if (n === 'integrity') return ''; // content is rewritten, hashes no longer match
    const v = dec(/^["']/.test(val) ? val.slice(1, -1) : val);
    if (URL_ATTRS.has(n)) return `${name}="${enc(px(v))}"`;
    if (n === 'srcset' || n === 'imagesrcset') return `${name}="${enc(srcset(v, px))}"`;
    if (n === 'style') return `${name}="${enc(rewriteCss(v, base, root))}"`;
    return m;
  });
  let out = html.replace(TAG, (m, raw, rattrs, body, tag, tattrs) => {
    if (raw) {
      const inner = raw.toLowerCase() === 'style' ? rewriteCss(body, base, root) : body;
      return `<${raw}${attrs(rattrs)}>${inner}</${raw}>`;
    }
    if (!tag) return m; // comment
    const t = tag.toLowerCase();
    if (t === 'base') return '';
    if (t === 'meta') {
      const a = tattrs.toLowerCase();
      if (/http-equiv\s*=\s*["']?content-security-policy/.test(a)) return '';
      if (/http-equiv\s*=\s*["']?refresh/.test(a)) {
        return `<${tag}${tattrs.replace(/(content\s*=\s*["'][^"']*?url\s*=\s*)([^"']+)/i,
          (x, p, u) => p + enc(px(dec(u.trim()))))}>`;
      }
    }
    return `<${tag}${attrs(tattrs)}>`;
  });
  const hook = `<script src="${root.slice(0, -2)}rt.js"></script>`;
  const at = [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /^\s*<!doctype[^>]*>/i]
    .map((re) => re.exec(out)).find(Boolean);
  out = at ? out.slice(0, at.index + at[0].length) + hook + out.slice(at.index + at[0].length)
    : hook + out;
  return out;
}
