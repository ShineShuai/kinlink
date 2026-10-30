// Run: node test/signaling.mjs   (no network; fake broker echoes publishes from a "foreign" id)
import assert from 'node:assert/strict';

globalThis.crypto ??= (await import('node:crypto')).webcrypto;
globalThis.MessageEvent ??= class extends Event {
  constructor(t, i) { super(t); this.data = i?.data; }
};

class FakeWS {
  constructor(url) { // 'dead' hosts fail, 'hang' hosts never answer
    if (url.includes('dead')) setTimeout(() => this.onerror(), 0);
    else if (!url.includes('hang')) setTimeout(() => this.onopen(), 0);
  }
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
const { FanoutAdapter } = await import('../src/signaling.js');

const secret = newSecret();
const a = await derive(secret);
const b = await derive(secret);
assert.equal(a.room, b.room);
assert.notEqual(a.room, (await derive(newSecret())).room);

const sealed = await sealText(a.sigKey, 'hello');
assert.equal(await openText(b.sigKey, sealed), 'hello');
const bad = `${sealed.slice(0, 20)}${sealed[20] === 'A' ? 'B' : 'A'}${sealed.slice(21)}`;
await assert.rejects(openText(b.sigKey, bad));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inner = new MqttWssAdapter('ws://fake', 'kinlink/room');
const m = new SealedAdapter(inner, a.sigKey);
await m.open();
const said = [];
m.addEventListener('message', (e) => said.push(e.data));
// The fake broker hands our publish back from a "foreign" connection, like a broker cluster does
// (broker.emqx.io and broker-cn.emqx.io): our own message must not reach us as a peer's.
await m.send('x'.repeat(3000));
await sleep(30);
assert.deepEqual(said, [], 'own message came back');
// A peer's messages: duplicates (one per broker) are delivered once, in order, forged ones never.
const one = await sealText(a.sigKey, 'y'.repeat(3000));
const two = await sealText(a.sigKey, 'second');
for (const t of [one, one, two, one, `${two.slice(0, 20)}!${two.slice(21)}`]) inner.emit(t);
await sleep(30);
assert.deepEqual(said.map((t) => t.length), [3000, 6]);
// the same text sealed again (a retry) is a new message
inner.emit(await sealText(a.sigKey, 'y'.repeat(3000)));
await sleep(30);
assert.equal(said.length, 3);
await m.close();

// connect timeout
await assert.rejects(new MqttWssAdapter('ws://hang', 't').open(20), /timeout/);

// fan-out: one dead broker is fine, all dead is an error, status and logs say which
const mq = (host) => [host, new MqttWssAdapter(`ws://${host}`, 'kinlink/room')];
const fan = new FanoutAdapter([mq('dead1'), mq('good1'), mq('good2')]);
const logs = [];
fan.onlog = (l) => logs.push(l);
await fan.open();
await new Promise((r) => setTimeout(r, 10)); // second broker joins late
assert.equal(fan.status(), '2/3 signaling servers');
assert.ok(logs.some((l) => /dead1: unreachable/.test(l)), logs.join('|'));
const heard = [];
fan.addEventListener('message', (e) => heard.push(e.data));
await fan.send('offer');
await new Promise((r) => setTimeout(r, 10));
assert.deepEqual(heard, ['offer', 'offer']); // duplicates via two brokers are expected
// events say which broker they came from; send(text, via) uses only that one while it is up
const vias = [];
fan.addEventListener('message', (e) => vias.push(e.via));
await fan.send('one', 'good2');
await new Promise((r) => setTimeout(r, 10));
assert.deepEqual(vias, ['good2'], 'one broker only');
vias.length = 0;
await fan.send('two', 'dead1'); // that broker is down: all that are up
await fan.send('three', 'nobody');
await new Promise((r) => setTimeout(r, 10));
assert.deepEqual(vias.sort(), ['good1', 'good1', 'good2', 'good2']);
const allDead = new FanoutAdapter([mq('dead1'), mq('dead2')]);
await assert.rejects(allDead.open(), /no signaling server reachable/);
await assert.rejects(allDead.send('x'), /no signaling server connected/);
await fan.close();
console.log('signaling ok');
