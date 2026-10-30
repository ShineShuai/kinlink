// Run: node test/remote.mjs   (pure parts of the remote browser)
import assert from 'node:assert/strict';
import {
  FrameAssembler, RB_ID, addressUrl, cdpInput, clickCounter, frameChunks, keyInput, mouseInput,
  rbWord, size, urlProblem, viewOf, wheelInput,
} from '../src/remote.js';

for (const u of ['http://127.0.0.1/', 'http://localhost:80/', 'http://10.0.0.1/', 'file:///etc/passwd',
  'chrome-extension://abc/index.html', 'javascript:alert(1)', 'data:text/html,x', 'http://a.com:8080/',
  'http://[::1]/', 'http://2130706433/', 'http://user@192.168.1.1/', 42, null, `http://a.com/${'x'.repeat(9000)}`]) {
  assert.ok(urlProblem(u), String(u).slice(0, 40));
}
for (const u of ['https://example.com/', 'http://site.test/x?y=1', 'https://a.com:443/']) {
  assert.equal(urlProblem(u), null, u);
}

assert.deepEqual(size(1, 99999), { w: 200, h: 1600 });
assert.deepEqual(size('x', undefined), { w: 1024, h: 640 });
const S = { w: 800, h: 600 };
assert.deepEqual(cdpInput({ t: 'm', k: 'down', x: 10.4, y: 9999, b: 1, n: 1, bs: 1, mod: 2 }, S), {
  method: 'Input.dispatchMouseEvent',
  params: { type: 'mousePressed', x: 10, y: 599, modifiers: 2, button: 'left', buttons: 1, clickCount: 1 },
});
assert.equal(cdpInput({ t: 'm', k: 'move', x: 1, y: 1, b: 3 }, S).params.button, 'none');
assert.deepEqual(cdpInput({ t: 'm', k: 'wheel', x: 5, y: 5, dx: -1e9, dy: 120 }, S).params,
  { type: 'mouseWheel', x: 5, y: 5, modifiers: 0, button: 'none', buttons: 0, clickCount: 0, deltaX: -5000, deltaY: 120 });
const key = cdpInput({ t: 'k', k: 'down', key: 'a', code: 'KeyA', vk: 65, text: 'a' }, S);
assert.equal(key.params.type, 'keyDown');
assert.equal(key.params.text, 'a');
assert.equal(cdpInput({ t: 'k', k: 'down', key: 'Enter', code: 'Enter', vk: 13 }, S).params.type, 'rawKeyDown');
assert.equal(cdpInput({ t: 'k', k: 'up', key: 'a', vk: 65, text: 'a' }, S).params.text, undefined);
assert.equal(cdpInput({ t: 'k', k: 'down', text: 'x'.repeat(100) }, S).params.text.length, 8);
assert.deepEqual(cdpInput({ t: 'i', s: 'héllo' }, S), { method: 'Input.insertText', params: { text: 'héllo' } });
for (const bad of [null, 5, {}, { t: 'x' }, { t: 'm', k: 'teleport' }, { t: 'k', k: 'sideways' }, { t: 'i', s: '' },
  { t: 'i', s: 7 }, { t: 'Target.closeTarget' }]) {
  assert.equal(cdpInput(bad, S), null, JSON.stringify(bad));
}
assert.equal(cdpInput({ t: 'm', k: 'move', x: 'NaN', y: {} }, S).params.x, 0);

// a JPEG of any size survives chunking and reassembly; chunks carry RB_ID and fit one message
const jpeg = Uint8Array.from({ length: 100000 }, (_, i) => (i * 11) & 255);
const chunks = [...frameChunks(jpeg)];
assert.ok(chunks.length > 5 && chunks.every((c) => c.length <= 16 * 1024));
assert.ok(chunks.every((c) => new DataView(c.buffer).getUint32(0) === RB_ID));
const got = [];
const asm = new FrameAssembler((blob, m) => got.push([blob, m]));
asm.chunk(new Uint8Array(5)); // no header yet: ignored
asm.head({ n: 7, len: jpeg.length, w: 800, h: 600 });
for (const c of chunks) asm.chunk(c.subarray(4));
assert.equal(got.length, 1);
assert.equal(got[0][1].n, 7);
assert.deepEqual(new Uint8Array(await got[0][0].arrayBuffer()), jpeg);
asm.head({ n: 8, len: 1e9, w: 1, h: 1 }); // absurd length: dropped
asm.chunk(new Uint8Array(10));
asm.head({ n: 9, len: 10, w: 1, h: 1 });
asm.chunk(new Uint8Array(20)); // longer than announced: dropped
assert.equal(got.length, 1);
// DOM events -> input messages, scaled from the canvas to the remote viewport
const rect = { left: 10, top: 20, width: 400, height: 300 };
const view = { w: 800, h: 600 };
const down = {
  clientX: 210, clientY: 170, button: 2, buttons: 2, detail: 1, shiftKey: true, ctrlKey: true,
};
assert.deepEqual(mouseInput('down', down, rect, view),
  { t: 'm', k: 'down', x: 400, y: 300, b: 3, bs: 2, n: 1, mod: 10 });
assert.equal(mouseInput('move', { clientX: 10, clientY: 20, button: 0 }, rect, view).b, 0);
const wheel = { clientX: 10, clientY: 20, deltaX: 0, deltaY: 3, deltaMode: 1 };
assert.equal(wheelInput(wheel, rect, view).dy, 48);
assert.deepEqual(keyInput('down', { key: 'a', code: 'KeyA', keyCode: 65 }),
  { t: 'k', k: 'down', key: 'a', code: 'KeyA', vk: 65, mod: 0, text: 'a' });
assert.equal(keyInput('down', { key: 'Enter', code: 'Enter', keyCode: 13 }).text, '\r');
const arrow = { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 };
assert.equal(keyInput('down', arrow).text, undefined);
const ctrlC = { key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true };
assert.equal(keyInput('down', ctrlC).text, undefined);
assert.equal(keyInput('up', { key: 'a', code: 'KeyA', keyCode: 65 }).text, undefined);
const ctrlV = { key: 'v', ctrlKey: true, keyCode: 86 };
assert.equal(keyInput('down', ctrlV), null, 'paste is a paste event');
assert.equal(keyInput('down', { key: 'Process', isComposing: true, keyCode: 229 }), null, 'IME');
assert.equal(addressUrl(' example.com/a '), 'https://example.com/a');
assert.equal(addressUrl('http://x.org'), 'http://x.org');
assert.deepEqual(viewOf({ width: 784, height: 377 }, 784), { w: 784, h: 377 }, 'cropped frame');
assert.deepEqual(viewOf({ width: 392, height: 189 }, 784), { w: 784, h: 378 }, 'scaled canvas');
const cc = clickCounter();
const ev = (t, x = 0, b = 0) => ({ timeStamp: t, clientX: x, clientY: 0, button: b });
const seq = [cc(ev(0)), cc(ev(200)), cc(ev(400)), cc(ev(600))];
assert.deepEqual(seq, [1, 2, 3, 3], 'triple click, capped');
assert.equal(cc(ev(2000)), 1, 'too late');
assert.equal(cc(ev(2100, 50)), 1, 'too far');
assert.equal(cc(ev(2200, 50, 2)), 1, 'other button');
const plain = { clientX: 10, clientY: 20, button: 0, detail: 0 };
assert.equal(mouseInput('down', plain, rect, view, 2).n, 2);
// status words: the Client's view (peer allows) and the Host's own
assert.equal(rbWord({ peerServes: true, peerRemote: true }), 'remote: host allows');
assert.equal(rbWord({ peerServes: true, peerRemote: false }), 'remote: host off');
assert.equal(rbWord({ peerServes: false, allowed: false }), 'remote: off');
assert.equal(rbWord({ allowed: true }), 'remote: allowed');
assert.equal(rbWord({ allowed: true, using: true }), 'remote: in use');
console.log('remote ok');
