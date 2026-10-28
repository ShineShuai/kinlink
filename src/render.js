// Turns a peer response into a browser Response (runs in the Service Worker, testable in Node).
import { rewriteCss, rewriteHtml } from './rewrite.js';

// Fail closed: anything the rewriting missed cannot reach a third-party host directly.
const CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; "
  + "style-src 'self' 'unsafe-inline'; frame-ancestors 'self'; form-action 'self'; base-uri 'self'";
const KEEP = ['content-type', 'content-range', 'accept-ranges', 'content-disposition'];
const EMPTY = new Set([204, 205, 304]);
const SCHEME = /^[a-z][a-z\d+.-]*:/i;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (status, msg) => new Response(
  `<!doctype html><meta charset=utf-8><title>Kinlink</title><pre>Kinlink: ${esc(msg)}</pre>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP } });
const redirect = (to) => new Response(null, { status: 302, headers: { location: to } });

function decode(buf, type) {
  const m = /charset\s*=\s*"?([\w-]+)/i.exec(type)
    ?? /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(new TextDecoder('latin1').decode(buf.slice(0, 2048)));
  try { return new TextDecoder(m?.[1] ?? 'utf-8').decode(buf); } catch { return new TextDecoder().decode(buf); }
}

// req: { url, method, headers } with url as typed after root. ask(url, headers) -> peer response
// { status, url, headers: [[k, v]], body: ArrayBuffer }. root: e.g. "/kinlink/~/".
export async function render(req, ask, root) {
  if (req.method !== 'GET') return page(501, `${req.method} is not supported yet`);
  let u;
  try { u = new URL(SCHEME.test(req.url) ? req.url : `https://${req.url}`); } catch { u = null; }
  if (!u || !/^https?:$/.test(u.protocol)) return page(400, `bad url: ${req.url}`);
  if (!SCHEME.test(req.url)) return redirect(root + u.href);
  let r;
  try { r = await ask(u.href, req.headers); } catch (e) { return page(502, e.message); }
  if (new URL(r.url).href !== u.href) return redirect(root + r.url); // base for relative URLs
  const type = r.headers.find(([k]) => k === 'content-type')?.[1] ?? '';
  const headers = new Headers({ 'content-security-policy': CSP });
  for (const [k, v] of r.headers) if (KEEP.includes(k)) headers.set(k, v);
  let body = EMPTY.has(r.status) ? null : r.body;
  if (body && /^(text\/html|application\/xhtml\+xml)/i.test(type)) {
    body = rewriteHtml(decode(r.body, type), r.url, root);
    headers.set('content-type', 'text/html; charset=utf-8');
  } else if (body && /^text\/css/i.test(type)) {
    body = rewriteCss(decode(r.body, type), r.url, root);
    headers.set('content-type', 'text/css; charset=utf-8');
  }
  return new Response(body, { status: r.status, headers });
}
