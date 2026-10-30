// Run: node test/manifest.mjs   (the manifest and the code must agree)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PERMS } from '../src/remote.js';
import { BUILD } from '../src/session.js';

const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));

// Chrome refuses these as optional_permissions: requesting them fails with "Only permissions
// specified in the manifest may be requested" (0016 did that with "debugger").
const NOT_OPTIONAL = ['debugger', 'declarativeNetRequest', 'devtools', 'experimental',
  'geolocation', 'mdns', 'proxy', 'tts', 'ttsEngine', 'wallpaper'];
for (const p of m.optional_permissions ?? []) assert.ok(!NOT_OPTIONAL.includes(p), `optional ${p}`);
for (const p of PERMS) {
  assert.ok(m.optional_permissions.includes(p), `${p} is requested at runtime`);
}
assert.ok(m.permissions.includes('debugger'), 'the remote browser needs it at install time');
assert.deepEqual(m.optional_host_permissions, ['<all_urls>']);

// pages show the build; the manifest and the service worker only change on "Reload" in
// chrome://extensions, so the page compares them (app.js)
assert.equal(m.version_name, BUILD, 'bump version_name together with BUILD');
assert.match(m.version, /^\d+\.\d+\.\d+$/);
assert.equal(m.background.type, 'module');
console.log('manifest ok');
