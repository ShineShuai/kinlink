import { BroadcastAdapter, FanoutAdapter } from './signaling.js';
import { MqttWssAdapter } from './mqtt.js';
import { SealedAdapter, derive } from './crypto.js';
import { Peer } from './p2p.js';
import { relayFallback } from './relay.js';
import { attach } from './proxy.js';

export const BUILD = '0015';

// One pairing session: signaling (all brokers), sealed, one Peer, the relay fallback and the
// request protocol. Used by the app tab and by the background Host (host.js).
// o: { secret, brokers, stun, rtc (RTCConfiguration extras), signaling ('mqtt' | 'bc'), relayAfter,
//      enabled, exec, onlog,
//      onhello, onstate({ sig, link, peer }) }
// Returns { peer, api, stop, dead() }; dead() says why an unattended Host should start over.
export async function openSession(o) {
  const { onlog = () => {}, onstate = () => {} } = o;
  const { room, sigKey, relayKey } = await derive(o.secret);
  let inner;
  if (o.signaling === 'bc') {
    inner = new BroadcastAdapter(`kinlink-${room}`);
    onstate({ sig: 'signaling: bc' });
  } else {
    inner = new FanoutAdapter(o.brokers.map(
      (u) => [new URL(u).host, new MqttWssAdapter(u, `kinlink/${room}`)]));
    inner.onlog = onlog;
    inner.addEventListener('state', () => onstate({ sig: `signaling: ${inner.status()}` }));
    onstate({ sig: 'signaling: connecting' });
  }
  const sig = new SealedAdapter(inner, sigKey);
  // Registered before the Peer's own listener, so offerSeen is still the old offer here. A session
  // that is over must not answer: the client would connect to it and be dropped at the restart.
  let newOffer = false; // an offer other than the one this Peer answered: a new client
  sig.addEventListener('message', (e) => {
    try {
      if (JSON.parse(e.data).type !== 'offer') return;
    } catch { return; } // not an SDP
    if (peer.offerSeen && e.data !== peer.offerSeen) newOffer = true;
    if (dead()) e.stopImmediatePropagation();
  });
  const dead = () => { // why an unattended Host should start over, or null
    const st = peer.pc.connectionState;
    const open = peer.dc?.readyState === 'open'; // direct or relay: it works, whatever ICE says
    const relaying = relay.chan.active && relay.chan.readyState === 'connecting';
    if (newOffer) return 'new client';
    if (peer.dc?.readyState === 'closed') return 'channel closed';
    if (!open && !relaying && (st === 'failed' || st === 'closed')) return `link ${st}`;
    if (inner.up && !inner.up.size && !open && !relaying) return 'no signaling server';
    return null;
  };
  const peer = new Peer(sig, o.stun.map((urls) => ({ urls })), o.rtc);
  peer.onlog = onlog;
  const link = () => onstate({
    link: peer.dc?.relay && peer.dc.readyState === 'open' && !peer.dc.useAlt
      ? 'relay' : peer.pc.connectionState,
  });
  peer.pc.addEventListener('connectionstatechange', link);
  const relay = relayFallback(peer, inner, relayKey, {
    after: o.relayAfter, onlog, canWake: () => !dead(),
  });
  for (const ev of ['open', 'close', 'switch']) relay.chan.addEventListener(ev, link);
  const api = attach(peer, {
    enabled: o.enabled, onlog, build: BUILD, onhello: o.onhello, exec: o.exec,
  });
  onstate({ link: 'new', peer: 'peer: not connected' });
  const stop = () => {
    relay.stop();
    sig.close().catch(() => {});
    peer.pc.close();
  };
  try {
    await sig.open();
  } catch (e) {
    stop();
    onstate({ sig: `signaling failed: ${e.message}` });
    throw e;
  }
  onlog(`build ${BUILD}, room ${room.slice(0, 8)}. Host: wait. Client: Offer.`);
  return { peer, api, relay, stop, dead };
}
