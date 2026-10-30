// Run: node test/stun.mjs   (fake RTCPeerConnection; pickStun keeps the servers that answer)
import assert from 'node:assert/strict';

const ANSWER = { 'stun:fast': 5, 'stun:mid': 30, 'stun:slow': 60 }; // others never answer
class FakePC {
  constructor({ iceServers }) { this.url = iceServers[0].urls; }
  createDataChannel() {}
  async createOffer() { return {}; }
  async setLocalDescription() {
    const ms = ANSWER[this.url];
    if (ms === undefined) return;
    const candidate = { type: 'srflx', address: '1.2.3.4', port: 9 };
    setTimeout(() => this.onicecandidate?.({ candidate }), ms);
  }
  close() {}
}
globalThis.RTCPeerConnection = FakePC;
const { pickStun } = await import('../src/diag.js');

{ // two never answer: the three that do, fastest first
  const t0 = Date.now();
  const urls = ['stun:dead', 'stun:slow', 'stun:fast', 'stun:mid', 'stun:dead2'];
  const r = await pickStun(urls, 400, 3);
  assert.deepEqual(r.up, ['stun:fast', 'stun:mid', 'stun:slow']);
  assert.equal(r.answered, 3);
  assert.equal(r.total, 5);
  assert.ok(Date.now() - t0 < 300, 'no wait for the dead ones once enough answered');
}
{ // fewer than max answer: those, after the timeout
  const r = await pickStun(['stun:dead', 'stun:mid'], 150, 3);
  assert.deepEqual(r.up, ['stun:mid']);
  assert.equal(r.rows.length, 2);
}
{ // none answers (UDP blocked): the first two, so the Peer still has something
  const r = await pickStun(['stun:a', 'stun:b', 'stun:c'], 100, 3);
  assert.deepEqual(r.up, ['stun:a', 'stun:b']);
  assert.equal(r.answered, 0);
}
{ // nothing to probe
  assert.deepEqual((await pickStun([])).up, []);
}
console.log('stun ok');
