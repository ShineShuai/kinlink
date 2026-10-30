// Run: node test/p2p.mjs   (fake RTCPeerConnection; offer/answer logic only)
import assert from 'node:assert/strict';
import { Peer, candidates } from '../src/p2p.js';
import { SignalingAdapter } from '../src/signaling.js';

let count = 0;
class FakePC {
  iceGatheringState = 'complete';
  signalingState = 'stable';
  remoteDescription = null;
  localDescription = null;
  remoteCalls = 0;
  createDataChannel() { return {}; }
  async getStats() {
    return new Map([['a', { type: 'candidate-pair', state: 'failed' }],
      ['b', { type: 'candidate-pair', state: 'failed' }], ['c', { type: 'local-candidate' }]]);
  }
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

// A broker cluster hands our own offer back: it must not be taken for the other side's offer
// (Chrome would roll our offer back and answer it ourselves).
{
  const [cw, hw] = wires();
  const send = cw.send.bind(cw);
  cw.send = async (t) => { await send(t); setTimeout(() => cw.emit(t), 0); }; // own copy comes back
  const hsend = hw.send.bind(hw);
  hw.send = async (t) => { await hsend(t); setTimeout(() => hw.emit(t), 0); };
  const client = new Peer(cw);
  const host = new Peer(hw);
  await client.offer(5, 10);
  await sleep(20);
  assert.equal(client.pc.remoteCalls, 1, 'the client applied only the answer');
  assert.equal(client.pc.remoteDescription.type, 'answer');
  assert.equal(host.pc.remoteCalls, 1, 'the host applied only the offer');
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

// ICE diagnostics
const sdp = [
  'a=candidate:1 1 udp 2122260223 a1b2c3.local 50000 typ host generation 0',
  'a=candidate:2 1 udp 2122260223 192.168.1.5 50001 typ host',
  'a=candidate:3 1 udp 1686052607 203.0.113.9 50001 typ srflx raddr 192.168.1.5 rport 50001',
  'a=candidate:4 1 udp 41885439 198.51.100.1 3478 typ relay',
].join('\r\n');
assert.deepEqual(candidates(sdp),
  { host: 2, mdns: 1, srflx: 1, relay: 1, srflxIps: ['203.0.113.9'] });
assert.deepEqual(candidates(), { host: 0, mdns: 0, srflx: 0, relay: 0, srflxIps: [] });
{
  const [cw] = wires();
  const p = new Peer(cw);
  const logs = [];
  p.onlog = (l) => logs.push(l);
  p.pc.localDescription = { sdp };
  p.pc.remoteDescription = { sdp };
  await p.explain();
  const all = logs.join('\n');
  assert.match(all, /ice local: host 2 \(1 mDNS\), srflx 1, relay 1 \| remote: host 2/);
  assert.match(all, /"failed":2/);
  assert.match(all, /same machine\/LAN/);
  p.pc.localDescription = { sdp: '' };
  logs.length = 0;
  await p.explain();
  assert.match(logs.join('\n'), /no STUN answer/);
}
console.log('p2p ok');
