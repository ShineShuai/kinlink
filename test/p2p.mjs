// Run: node test/p2p.mjs   (fake RTCPeerConnection; offer/answer logic only)
import assert from 'node:assert/strict';
import { Peer } from '../src/p2p.js';
import { SignalingAdapter } from '../src/signaling.js';

let count = 0;
class FakePC {
  iceGatheringState = 'complete';
  signalingState = 'stable';
  remoteDescription = null;
  localDescription = null;
  remoteCalls = 0;
  createDataChannel() { return {}; }
  async createOffer() { return { type: 'offer', sdp: `offer${++count}` }; }
  async createAnswer() { return { type: 'answer', sdp: `answer${++count}` }; }
  async setLocalDescription(d) {
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d) {
    this.remoteCalls++;
    this.remoteDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
}
globalThis.RTCPeerConnection = FakePC;

// A wire that can drop messages, like a broker the other side has not subscribed to yet.
class Wire extends SignalingAdapter {
  sent = [];
  drop = false;
  async send(text) {
    this.sent.push(text);
    if (!this.other.drop) setTimeout(() => this.other.emit(text), 0);
  }
}
const wires = () => {
  const [a, b] = [new Wire(), new Wire()];
  a.other = b;
  b.other = a;
  return [a, b];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Host subscribes late: offers sent before are lost, the retry gets through exactly once applied.
{
  const [cw, hw] = wires();
  hw.drop = true;
  const client = new Peer(cw);
  const host = new Peer(hw);
  setTimeout(() => { hw.drop = false; }, 35);
  await client.offer(20, 10);
  assert.equal(client.pc.remoteDescription?.type, 'answer');
  assert.equal(host.pc.remoteCalls, 1, 'duplicate offers must not be applied twice');
  assert.equal(client.pc.remoteCalls, 1, 'duplicate answers must not be applied twice');
  assert.ok(cw.sent.length >= 3, `offer was re-sent: ${cw.sent.length}`);
  assert.ok(cw.sent.length <= 8, `retries stop once answered: ${cw.sent.length}`);
}

// Lost answer: a repeated offer makes the host repeat its answer instead of failing.
{
  const [cw, hw] = wires();
  const client = new Peer(cw);
  const host = new Peer(hw);
  cw.drop = true; // answers are lost
  const offer = client.offer(2, 10);
  await sleep(30);
  cw.drop = false;
  await offer;
  await sleep(10);
  assert.ok(hw.sent.length >= 2, 'answer repeated');
  assert.equal(host.pc.remoteCalls, 1);
}

// Nobody there: gives up and says so.
{
  const [cw] = wires();
  cw.other.drop = true;
  const client = new Peer(cw);
  const logs = [];
  client.onlog = (l) => logs.push(l);
  await client.offer(2, 5);
  assert.ok(logs.some((l) => /gave up/.test(l)), logs.join('|'));
}
console.log('p2p ok');
