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

// Symmetric peer. Non-trickle: one SDP message each way over any SignalingAdapter.
export class Peer {
  onlog = () => {};
  onrtt = null;
  rx = 0;
  initiator = false;

  constructor(sig, iceServers = []) {
    this.sig = sig;
    this.pc = new RTCPeerConnection({ iceServers });
    this.pc.onconnectionstatechange = () => this.onlog(`pc: ${this.pc.connectionState}`);
    this.pc.oniceconnectionstatechange = () => this.onlog(`ice: ${this.pc.iceConnectionState}`);
    this.pc.ondatachannel = (e) => this.wire(e.channel);
    sig.addEventListener('message', (e) =>
      this.accept(e.data).catch((err) => this.onlog(`err: ${err.message}`)));
  }

  wire(dc) {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = HIGH / 4;
    dc.onopen = () => { this.onlog('dc: open'); this.onopen?.(); };
    dc.onclose = () => this.onlog('dc: close');
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
    if (op === 'ping') this.dc.send(`pong:${arg}`);
    else if (op === 'pong') this.onrtt?.(performance.now() - Number(arg));
    else if (op === 'start') this.rx = 0;
    else if (op === 'end') this.dc.send(`ack:${this.rx}`);
    else if (op === 'ack') this.acked?.(Number(arg));
    else this.onctl?.(op, arg);
  }

  ping() { this.dc.send(`ping:${performance.now()}`); }

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
