// HTTP cache of the Client (private, in memory: it dies with the tab, nothing is written to disk).
// It sits between browse.js and the peer, so a hit costs no round trip over the slow link.
// Like a browser's cache, for GET only:
//   fresh (Cache-Control max-age, or Expires) -> answered here
//   stale with ETag / Last-Modified           -> revalidated: the Host sends If-None-Match /
//                                                If-Modified-Since, a 304 reuses the stored body
//   not stored: no-store, Set-Cookie, Vary: Cookie or *, Range requests, bodies over `entry` bytes,
//   anything but 200 (and 301/308 with an explicit lifetime). No heuristic lifetimes.
// A non-GET request for a URL drops it. Entries are replaced least-recently-used past `max` bytes.
const KEEP_FRESH = new Set([200, 301, 308]);
const lower = (o = {}) => Object.fromEntries(
  Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));

const header = (headers, name) => headers.find(([k]) => k === name)?.[1];

// Lifetime in ms from the response headers (0: must revalidate), age already taken off.
export function lifetime(headers) {
  const cc = header(headers, 'cache-control') ?? '';
  if (/(^|,)\s*(no-cache|no-store)\b/i.test(cc)) return 0;
  const age = Number(header(headers, 'age')) || 0;
  const m = /(^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(cc);
  if (m) return Math.max(0, Number(m[2]) - age) * 1000;
  const exp = Date.parse(header(headers, 'expires'));
  const date = Date.parse(header(headers, 'date')) || Date.now();
  return Number.isFinite(exp) ? Math.max(0, exp - date - age * 1000) : 0;
}

export class HttpCache {
  entries = new Map(); // url -> entry; Map order = recency
  bytes = 0;
  stats = { hit: 0, revalidated: 0, miss: 0 };

  constructor({ max = 64 << 20, entry = 8 << 20, now = Date.now } = {}) {
    Object.assign(this, { max, entry, now });
  }

  // net(headers) performs the real request: it is called with the conditional headers added.
  async fetch(url, headers, { method = 'GET' } = {}, net) {
    const key = url.split('#')[0];
    const h = lower(headers);
    if (method !== 'GET') {
      this.drop(key);
      return net(headers);
    }
    if (h.range) return net(headers); // media ranges: not cached
    const e = this.entries.get(key);
    const usable = e && e.vary.every(([n, v]) => (h[n] ?? '') === v);
    if (usable && this.now() - e.at < e.ttl) {
      this.touch(key, e);
      this.stats.hit++;
      return this.reply(e);
    }
    const cond = usable && (e.etag || e.modified) ? {
      ...headers,
      ...(e.etag ? { 'if-none-match': e.etag } : {}),
      ...(e.modified ? { 'if-modified-since': e.modified } : {}),
    } : headers;
    const r = await net(cond);
    if (usable && cond !== headers && r.status === 304) {
      this.refresh(e, r);
      this.touch(key, e);
      this.stats.revalidated++;
      return this.reply(e, r.cookies);
    }
    this.stats.miss++;
    this.drop(key);
    this.put(key, h, r);
    return r;
  }

  reply(e, cookies = []) {
    return { status: e.status, url: e.url, headers: e.headers, cookies, location: e.location,
      body: e.body, cached: true };
  }

  touch(key, e) {
    this.entries.delete(key);
    this.entries.set(key, e);
  }

  drop(key) {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.bytes -= e.size;
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }

  put(key, reqHeaders, r) {
    if (r.cookies?.length || !r.body || r.body.size > this.entry) return;
    const cc = header(r.headers, 'cache-control') ?? '';
    const vary = (header(r.headers, 'vary') ?? '').toLowerCase().split(',').map((s) => s.trim())
      .filter(Boolean);
    if (/\bno-store\b/i.test(cc) || vary.includes('*') || vary.includes('cookie')) return;
    const ttl = lifetime(r.headers);
    const etag = header(r.headers, 'etag');
    const modified = header(r.headers, 'last-modified');
    if (!KEEP_FRESH.has(r.status) || (r.status !== 200 && !ttl)) return;
    if (!ttl && !etag && !modified) return; // nothing to reuse
    const e = {
      status: r.status, url: r.url, headers: r.headers, location: r.location, body: r.body,
      size: r.body.size, at: this.now(), ttl, etag, modified,
      vary: vary.filter((n) => n !== 'accept-encoding').map((n) => [n, reqHeaders[n] ?? '']),
    };
    this.entries.set(key, e);
    this.bytes += e.size;
    while (this.bytes > this.max) this.drop(this.entries.keys().next().value);
  }

  // a 304: its headers update the stored ones (freshness, validators), the body stays
  refresh(e, r) {
    const next = new Map(e.headers);
    for (const [k, v] of r.headers) if (!k.startsWith('content-')) next.set(k, v);
    e.headers = [...next];
    e.at = this.now();
    e.ttl = lifetime(e.headers);
    e.etag = header(e.headers, 'etag');
    e.modified = header(e.headers, 'last-modified');
  }
}
