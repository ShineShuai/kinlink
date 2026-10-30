// Run: node test/session.mjs   (fake RTCPeerConnection, BroadcastChannel signaling)
import assert from 'node:assert/strict';

globalThis.crypto ??= (await import('node:crypto')).webcrypto;
class FakePC extends EventTarget {
  connectionState = 'new';
  iceGatheringState = 'complete';
  createDataChannel() { return {}; }
  close() { this.connectionState = 'closed'; }
}
globalThis.RTCPeerConnection = FakePC;
const { openSession } = await import('../src/session.js');
const { newSecret } = await import('../src/crypto.js');

const open = () => openSession({
  secret: newSecret(), brokers: [], stun: [], signaling: 'bc', relayAfter: 60000,
  enabled: () => true,
});
const keep = setInterval(() => {}, 1000);

// dead(): what the background Host's supervisor restarts on
{
  const s = await open();
  const set = (st, dc) => { s.peer.pc.connectionState = st; s.peer.dc = dc; };
  assert.equal(s.dead(), null, 'fresh session waits for a client');
  set('connecting', undefined);
  assert.equal(s.dead(), null);
  set('failed', undefined);
  assert.equal(s.dead(), 'link failed', 'no path and no relay: start over');
  set('failed', { readyState: 'open' });
  assert.equal(s.dead(), null, 'relay (or direct) channel works although ICE failed');
  set('failed', { readyState: 'closed' });
  assert.equal(s.dead(), 'channel closed');
  set('failed', undefined);
  s.relay.chan.activate(); // relay handshake in progress: give it its time
  assert.equal(s.dead(), null);
  s.relay.chan.shut();
  assert.equal(s.dead(), 'link failed', 'relay gave up: start over');
  s.stop();
}
{
  const s = await open();
  s.peer.pc.connectionState = 'closed';
  assert.equal(s.dead(), 'link closed');
  s.stop();
}
clearInterval(keep);
console.log('session ok');
