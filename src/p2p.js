const CHUNK = 16 * 1024;
const HIGH = 4 << 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gathered = (pc, ms = 5000) => new Promise((done) => {
  if (pc.iceGatheringState === 'complete') return done();
  const t = setTimeout(done, ms);
  pc.addEventListener('icegatheringstatechange', () => {
    if (pc.iceGatheringState === 'complete') { clearTimeout(t); done(); }
  });
});

// Counts the ICE candidates in an SDP: host (mDNS ones counted separately), srflx, relay.
export function candidates(sdp = '') {
  const c = { host: 0, mdns: 0, srflx: 0, relay: 0, srflxIps: [] };
  for (const m of sdp.matchAll(/^a=candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ (\w+)/gm)) {
    const [, ip, type] = m;
    if (type === 'host') { c.host++; if (ip.endsWith('.local')) c.mdns++; }
    else if (type === 'srflx') { c.srflx++; c.srflxIps.push(ip); }
    else if (type === 'relay') c.relay++;
  }
  return c;
}
const fmt = (c) => `host ${c.host}${c.mdns ? ` (${c.mdns} mDNS)` : ''}, srflx ${c.srflx}, relay ${c.relay}`;

// Symmetric peer. Non-trickle: one SDP message each way over any SignalingAdapter.
export class Peer {
  onlog = () => {};
  onrtt = null;
  rx = 0;
  initiator = false;

  constructor(sig, iceServers = [], config = {}) {
    this.sig = sig;
    this.pc = new RTCPeerConnection({ iceServers, ...config });
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      this.onlog(`pc: ${st}`);
      clearTimeout(this.slow);
      if (st === 'connecting') this.slow = setTimeout(() => this.explain(), 12000);
      if (st === 'failed') this.explain();
    };
    this.pc.oniceconnectionstatechange = () => this.onlog(`ice: ${this.pc.iceConnectionState}`);
    this.pc.ondatachannel = (e) => this.wire(e.channel);
    this.busy = Promise.resolve(); // one message at a time: setRemoteDescription must not overlap
    sig.addEventListener('message', (e) => {
      this.busy = this.busy.then(() => this.accept(e.data))
        .catch((err) => this.onlog(`err: ${err.message}`));
    });
  }

  // Why is there no connection? Logs candidate counts, pair states and a likely reason.
  async explain() {
    const l = candidates(this.pc.localDescription?.sdp);
    const r = candidates(this.pc.remoteDescription?.sdp);
    this.onlog(`ice local: ${fmt(l)} | remote: ${fmt(r)}`);
    const pairs = {};
    try {
      for (const s of (await this.pc.getStats()).values()) {
        if (s.type === 'candidate-pair') pairs[s.state] = (pairs[s.state] ?? 0) + 1;
      }
    } catch { /* stats unavailable */ }
    this.onlog(`ice pairs: ${JSON.stringify(pairs)}`);
    if (!l.srflx && !l.relay) this.onlog('hint: no STUN answer: UDP blocked, or a WebRTC privacy extension/policy?');
    if (!l.host) this.onlog('hint: no local host candidates: hidden by a WebRTC privacy policy/extension');
    if (l.srflxIps.some((ip) => r.srflxIps.includes(ip))) {
      this.onlog('hint: both sides share one public IP (same machine/LAN). Direct paths are hidden'
        + ' (mDNS) and the router would need NAT hairpinning: test from two different networks');
    }
  }

  // A relay channel (src/relay.js) stays this.dc once chosen. A direct channel that opens late is
  // handed to it (adopt): it takes over sending at a safe moment, see RelayChannel.
  wire(dc) {
    const keep = this.dc?.relay && this.dc.readyState !== 'closed' && !dc.relay;
    if (!keep) this.dc = dc; else this.dc.adopt(dc);
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = HIGH / 4;
    dc.onopen = () => {
      const tag = dc.relay ? ' (relay)' : keep ? ' (late, adopted)' : '';
      this.onlog(`dc: open${tag}`);
      if (!keep) this.onopen?.();
    };
    dc.onclose = () => this.onlog(`dc: close${dc.relay ? ' (relay)' : ''}`);
    dc.onmessage = (e) => this.onmsg(e.data);
  }

  async describe(kind) { // 'createOffer' | 'createAnswer'
    await this.pc.setLocalDescription(await this.pc[kind]());
    await gathered(this.pc);
    this.sent = JSON.stringify(this.pc.localDescription);
    await this.sig.send(this.sent);
  }

  // Signaling is not retained: if the other side connects later, it would miss the offer.
  // So the offer is re-sent until an answer arrives (order of clicks does not matter).
  async offer(retries = 20, ms = 3000) {
    this.initiator = true;
    this.wire(this.pc.createDataChannel('kinlink'));
    await this.describe('createOffer');
    for (let i = 1; i <= retries; i++) {
      await sleep(ms);
      if (this.pc.remoteDescription || this.pc.signalingState === 'closed') return;
      this.onlog(`no answer yet (${i}/${retries}): other side connected, same secret?`);
      await this.sig.send(this.sent).catch((e) => this.onlog(`err: ${e.message}`));
    }
    this.onlog('gave up: no answer');
  }

  async accept(text) {
    if (text === this.sent) return; // our own message, handed back by a broker cluster
    const desc = JSON.parse(text);
    if (desc.type === 'offer') {
      if (text === this.offerSeen) { // a retry: our answer may have been lost, send it again
        if (this.sent) await this.sig.send(this.sent);
        return;
      }
      this.offerSeen = text;
    } else if (this.pc.signalingState !== 'have-local-offer') {
      return; // duplicate answer
    }
    await this.pc.setRemoteDescription(desc);
    if (desc.type === 'offer') await this.describe('createAnswer');
  }

  // Unknown ops go to onctl(op, arg); binary goes to onbin(ArrayBuffer) when set.
  onmsg(d) {
    if (typeof d !== 'string') {
      if (this.onbin) this.onbin(d); else this.rx += d.byteLength;
      return;
    }
    const k = d.indexOf(':');
    const op = d.slice(0, k);
    const arg = d.slice(k + 1);
    if (op === 'ping') this.say(`pong:${arg}`);
    else if (op === 'pong') this.onrtt?.(performance.now() - Number(arg));
    else if (op === 'start') this.rx = 0;
    else if (op === 'end') this.say(`ack:${this.rx}`);
    else if (op === 'ack') this.acked?.(Number(arg));
    else this.onctl?.(op, arg);
  }

  // Control text; dropped (false) while the channel is not open, e.g. after the link failed.
  say(text) {
    if (this.dc?.readyState !== 'open') return false;
    this.dc.send(text);
    return true;
  }

  ping() { this.say(`ping:${performance.now()}`); }

  async tx(data) { // send with backpressure
    if (this.dc.bufferedAmount > HIGH) {
      await new Promise((r) => this.dc.addEventListener('bufferedamountlow', r, { once: true }));
    }
    this.dc.send(data);
  }

  // One direction at a time; the receiver acks the byte count after 'end'.
  async blast(bytes) {
    const { dc } = this;
    const buf = new Uint8Array(CHUNK);
    const ack = new Promise((r) => { this.acked = r; });
    const t0 = performance.now();
    dc.send('start:');
    for (let n = 0; n < bytes; n += CHUNK) {
      await this.tx(buf);
    }
    dc.send('end:');
    const got = await ack;
    const s = (performance.now() - t0) / 1000;
    return { bytes: got, s, mbps: (got * 8) / s / 1e6 };
  }

  // Selected ICE path, e.g. "srflx/srflx udp", "relay/host tcp".
  async path() {
    const stats = await this.pc.getStats();
    const pair = [...stats.values()].find(
      (r) => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded');
    if (!pair) return null;
    const l = stats.get(pair.localCandidateId);
    const r = stats.get(pair.remoteCandidateId);
    return `${l.candidateType}/${r.candidateType} ${l.protocol}`;
  }
}
