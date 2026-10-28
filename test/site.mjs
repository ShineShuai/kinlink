// Run: node test/site.mjs   Builds the site and checks that it is self-contained.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const out = mkdtempSync(join(tmpdir(), 'kinlink-site-'));
execFileSync('bash', ['scripts/build-site.sh', out], { stdio: 'pipe' });
const walk = (d) => readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const files = walk(out);

const refs = (file, text) => {
  const rel = [];
  if (file.endsWith('.html')) for (const m of text.matchAll(/\b(?:src|href)=([^\s>"']+|"[^"]*")/g)) rel.push(m[1]);
  if (file.endsWith('.js')) {
    for (const m of text.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) rel.push(m[1]);
    // register() resolves against the page (site root), not the importing module
    for (const m of text.matchAll(/register\(\s*['"]([^'"]+)['"]/g)) rel.push(`/${m[1]}`);
  }
  return rel.map((r) => r.replace(/^"|"$/g, '')).filter((r) => !/^(https?:|#|data:|mailto:)/.test(r));
};
for (const f of files.filter((x) => /\.(html|js)$/.test(x))) {
  for (const r of refs(f, readFileSync(f, 'utf8'))) {
    const p = r.split(/[?#]/)[0];
    const target = p.startsWith('/') ? join(out, p) : join(dirname(f), p);
    assert.ok(existsSync(target), `${relative(out, f)} references missing ${r}`);
  }
}
for (const must of ['index.html', 'diag.html', 'app.js', 'diag-app.js', 'rt.js', 'render-sw.js', '.nojekyll']) {
  assert.ok(existsSync(join(out, must)), `site lacks ${must}`);
}
// Extension pages forbid inline scripts and inline handlers (CSP script-src 'self').
for (const f of files.filter((x) => x.endsWith('.html'))) {
  const html = readFileSync(f, 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${relative(out, f)}: inline <script>`);
  assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(html), `${relative(out, f)}: inline event handler`);
}
for (const bad of ['manifest.json', 'background.js', 'test']) {
  assert.ok(!existsSync(join(out, bad)), `site must not contain ${bad}`);
}
rmSync(out, { recursive: true });
console.log('site ok');
