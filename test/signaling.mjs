// Run: node test/signaling.mjs   (no network; fake broker echoes publishes from a "foreign" id)
import assert from 'node:assert/strict';

globalThis.crypto ??= (await import('node:crypto')).webcrypto;
globalThis.MessageEvent ??= class extends Event {
  constructor(t, i) { super(t); this.data = i?.data; }
};

class FakeWS {
  constructor() { setTimeout(() => this.onopen(), 0); }
  push(u8, cut = u8.length) { // deliver as two chunks to exercise reassembly
    for (const part of [u8.slice(0, cut), u8.slice(cut)]) {
      setTimeout(() => this.onmessage({ data: part.buffer }), 0);
    }
  }
  send(d) {
    let j = 1;
    while (d[j++] & 128);
    const body = d.subarray(j);
    const type = d[0] >> 4;
    if (type === 1) this.push(Uint8Array.of(0x20, 2, 0, 0));
    if (type === 8) this.push(Uint8Array.of(0x90, 3, body[0], body[1], 0));
    if (type === 3) {
      const echo = d.slice();
      echo[j + 2 + ((body[0] << 8) | body[1])] ^= 0xff; // flip first id byte: foreign sender
      this.push(echo, 5);
    }
  }
  close() {}
}
globalThis.WebSocket = FakeWS;

const { derive, newSecret, sealText, openText, SealedAdapter } = await import('../src/crypto.js');
const { MqttWssAdapter } = await import('../src/mqtt.js');

const secret = newSecret();
const a = await derive(secret);
const b = await derive(secret);
assert.equal(a.room, b.room);
assert.notEqual(a.room, (await derive(newSecret())).room);

const sealed = await sealText(a.sigKey, 'hello');
assert.equal(await openText(b.sigKey, sealed), 'hello');
const bad = `${sealed.slice(0, 20)}${sealed[20] === 'A' ? 'B' : 'A'}${sealed.slice(21)}`;
await assert.rejects(openText(b.sigKey, bad));

const m = new SealedAdapter(new MqttWssAdapter('ws://fake', 'kinlink/room'), a.sigKey);
await m.open();
const got = new Promise((r) => m.addEventListener('message', (e) => r(e.data)));
await m.send('x'.repeat(3000));
assert.equal((await got).length, 3000);
await m.close();
console.log('signaling ok');
