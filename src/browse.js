// Browser logic on the Client, on top of the one-hop peer API: cookies, redirects, Referer/Origin.
// The Host returns every hop (status, Location, Set-Cookie) and never follows redirects itself,
// so each hop gets the right cookies and passes the Host's SSRF check.
import { Jar } from './cookies.js';

const MAX_HOPS = 10;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

// Browsers trim cross-origin referrers to the origin (strict-origin-when-cross-origin).
const refererFor = (url, referer) => {
  if (!referer) return undefined;
  const [a, b] = [new URL(referer), new URL(url)];
  if (a.protocol === 'https:' && b.protocol === 'http:') return undefined;
  return a.origin === b.origin ? a.href.split('#')[0] : `${a.origin}/`;
};

export function browser(api, jar = new Jar()) {
  return {
    jar,
    // opts: { method, headers, body (ArrayBuffer), referer (real url of the page asking) }
    async fetch(url, { method = 'GET', headers = {}, body, referer } = {}) {
      const page = referer; // redirects keep the original referrer, like a browser
      for (let hop = 0; ; hop++) {
        const r = await api.fetch(url, headers, {
          method, body, cookie: jar.header(url), referer: refererFor(url, page),
          origin: method === 'POST' && page ? new URL(page).origin : undefined,
        });
        jar.store(url, r.cookies);
        if (!r.location || !REDIRECT.has(r.status)) return { ...r, url: r.url ?? url };
        if (hop >= MAX_HOPS) throw new Error('too many redirects');
        const next = new URL(r.location, url).href;
        if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        url = next;
      }
    },
  };
}
