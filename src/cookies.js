// Cookie jar of the Client. The Host stays stateless: the Client owns its identity at the sites.
// Simplified RFC 6265: host-only vs Domain, Path, Secure, Max-Age/Expires. No SameSite, no public
// suffix list (a site could set a cookie for a whole public suffix: known gap).

const defaultPath = (p) => (p.lastIndexOf('/') > 0 ? p.slice(0, p.lastIndexOf('/')) : '/');
const domainMatch = (host, d) => host === d || host.endsWith(`.${d}`);
const pathMatch = (p, c) => p === c || (p.startsWith(c) && (c.endsWith('/') || p[c.length] === '/'));

export class Jar {
  list = [];

  constructor(now = () => Date.now()) { this.now = now; }

  // setCookies: Set-Cookie header values received for `url`.
  store(url, setCookies = []) {
    const u = new URL(url);
    for (const line of setCookies) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const c = { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: u.hostname,
        hostOnly: true, path: defaultPath(u.pathname), secure: false, expires: Infinity };
      let ok = true;
      let maxAge = false;
      for (const a of attrs) {
        const k = a.split('=')[0].toLowerCase();
        const v = a.slice(k.length + 1);
        if (k === 'domain') {
          const d = v.replace(/^\./, '').toLowerCase();
          if (d && domainMatch(u.hostname, d)) { c.domain = d; c.hostOnly = false; } else ok = false;
        } else if (k === 'path' && v.startsWith('/')) c.path = v;
        else if (k === 'secure') c.secure = true;
        else if (k === 'max-age' && /^-?\d+$/.test(v)) { c.expires = this.now() + Number(v) * 1000; maxAge = true; }
        else if (k === 'expires' && !maxAge && !Number.isNaN(Date.parse(v))) c.expires = Date.parse(v);
      }
      if (!ok || (c.secure && u.protocol !== 'https:')) continue;
      this.list = this.list.filter((x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path));
      if (c.expires > this.now()) this.list.push(c);
    }
    if (this.list.length > 3000) this.list.splice(0, this.list.length - 3000);
  }

  // Cookie header value for a request to `url`, or '' if none.
  header(url) {
    const u = new URL(url);
    const now = this.now();
    this.list = this.list.filter((c) => c.expires > now);
    return this.list
      .filter((c) => (c.hostOnly ? u.hostname === c.domain : domainMatch(u.hostname, c.domain))
        && pathMatch(u.pathname, c.path) && (!c.secure || u.protocol === 'https:'))
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }
}
