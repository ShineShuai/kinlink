import { openBytes, sealBytes } from './crypto.js';

// Fallback transport when WebRTC finds no path (CGNAT, same NAT, UDP blocked): sealed frames
// over the signaling brokers. The medium is QoS 0 and may lose, duplicate and reorder, so this
// is a small ARQ: sequence numbers, cumulative acks, a send window, retransmit with backoff.
// RelayChannel mimics the RTCDataChannel subset that Peer and proxy.js use.
//
// Frame (sealed with the relay key): [type u8][sid u32][seq u32][flags u8][payload]
//   OPEN: handshake, repeated until the peer answers (flags bit0 = a reply, not answered again).
//   DATA: seq = frame number, flags bit0 = last fragment of a message, bit1 = binary message.
//   ACK: seq = next expected frame.
const FRAME = 8 * 1024; // payload bytes per frame (about 11 KiB on the wire)
const WINDOW = 16; // unacked frames in flight
const [OPEN, DATA, ACK] = [0, 1, 2];
const te = new TextEncoder();
const td = new TextDecoder();

const pack = (type, sid, seq, flags = 0, data = new Uint8Array(0)) => {
  const f = new Uint8Array(10 + data.length);
  const v = new DataView(f.buffer);
  f[0] = type;
  v.setUint32(1, sid);
  v.setUint32(5, seq);
  f[9] = flags;
  f.set(data, 10);
  return f;
};
const unpack = (f) => {
  if (f.length < 10) throw new Error('short frame');
  const v = new DataView(f.buffer, f.byteOffset, f.byteLength);
  return {
    type: f[0], sid: v.getUint32(1), seq: v.getUint32(5), flags: f[9], data: f.subarray(10),
  };
};

export class RelayChannel extends EventTarget {
  relay = true;
  binaryType = 'arraybuffer';
  bufferedAmountLowThreshold = 0;
  bufferedAmount = 0; // payload bytes queued or unacked
  readyState = 'connecting';
  active = false; // false: only listening; a peer's OPEN wakes it (see onwake)
  sid = crypto.getRandomValues(new Uint32Array(1))[0];
  peerSid = null;
  old = new Set(); // peer session ids replaced by a restart: late duplicates of those are dropped
  onopen = null;
  onclose = null;
  onmessage = null;
  onwake = null; // () => void; must call activate()

  queue = []; // frames waiting for window space
  flight = new Map(); // seq -> { bytes, at, tries }
  next = 0; // next seq to assign
  expect = 0; // next seq to deliver
  ahead = new Map(); // out-of-order frames by seq
  parts = [];

  constructor(inner, key, { tickMs = 500, rtoMs = 1000, openMs = 60000, send } = {}) {
    super();
    Object.assign(this, { inner, key, tickMs, rtoMs, openMs });
    this.xmit = send ?? ((text) => inner.send(text));
    this.listener = (e) => this.hear(e.data);
    inner.addEventListener('message', this.listener);
  }

  activate() {
    if (this.active) return;
    this.active = true;
    this.t0 = Date.now();
    this.lastOpen = 0;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
    this.tick();
  }

  async put(bytes) { // best effort: loss is handled by retransmission
    try {
      await this.xmit(await sealBytes(this.key, bytes));
    } catch { /* no broker up right now */ }
  }

  tick() {
    const now = Date.now();
    if (this.readyState === 'connecting') {
      if (now - this.t0 > this.openMs) return this.shut();
      if (now - this.lastOpen >= 2 * this.tickMs) {
        this.lastOpen = now;
        this.put(pack(OPEN, this.sid, 0));
      }
    }
    let n = 0;
    for (const [seq, fl] of this.flight) {
      if (now - fl.at < Math.min(this.rtoMs * 2 ** fl.tries, 8 * this.rtoMs)) continue;
      if (fl.tries >= 10) return this.shut();
      fl.tries++;
      fl.at = now;
      this.put(fl.bytes);
      if (++n >= 4) break; // oldest first; the rest wait for the next tick
    }
  }

  async hear(text) {
    if (this.readyState === 'closed') return;
    let f;
    try { f = unpack(await openBytes(this.key, text)); } catch { return; } // foreign or forged
    if (this.old.has(f.sid)) return;
    if (!this.active) { // the peer chose the relay: join it
      if (f.type !== OPEN) return;
      this.onwake?.();
      if (!this.active) return;
    }
    if (f.type === OPEN) {
      const again = this.peerSid !== null && this.peerSid !== f.sid; // peer restarted
      if (this.peerSid !== f.sid) this.resetStreams(f.sid);
      if (!(f.flags & 1)) this.put(pack(OPEN, this.sid, 0, 1)); // reply (flag 1): never answered
      if (this.readyState === 'connecting' || again) this.opened();
    } else if (f.sid === this.peerSid && this.readyState === 'open') {
      if (f.type === DATA) this.data(f); else if (f.type === ACK) this.acked(f.seq);
    }
  }

  resetStreams(peerSid) {
    if (this.peerSid !== null) this.old.add(this.peerSid);
    this.peerSid = peerSid;
    this.queue.length = 0;
    this.flight.clear();
    this.ahead.clear();
    this.parts = [];
    this.next = this.expect = this.bufferedAmount = 0;
  }

  opened() {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
    this.onopen?.();
  }

  data(f) {
    if (f.seq >= this.expect && f.seq < this.expect + WINDOW) this.ahead.set(f.seq, f);
    for (let g; (g = this.ahead.get(this.expect)); this.expect++) { // deliver in order
      this.ahead.delete(this.expect);
      this.parts.push(g.data);
      if (!(g.flags & 1)) continue;
      const u8 = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
      this.parts.reduce((o, p) => (u8.set(p, o), o + p.length), 0);
      this.parts = [];
      this.onmessage?.({ data: g.flags & 2 ? u8.buffer : td.decode(u8) });
    }
    this.ackTimer ??= setTimeout(() => { // coalesce: one ack per burst, duplicates re-acked too
      this.ackTimer = null;
      this.put(pack(ACK, this.sid, this.expect));
    }, 20);
    this.ackTimer.unref?.();
  }

  acked(upTo) {
    const before = this.bufferedAmount;
    for (const [seq, fl] of this.flight) {
      if (seq >= upTo) break; // Map keeps insertion order = seq order
      this.flight.delete(seq);
      this.bufferedAmount -= fl.size;
    }
    this.pump();
    if (before > this.bufferedAmountLowThreshold
      && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
      this.dispatchEvent(new Event('bufferedamountlow'));
    }
  }

  pump() {
    while (this.queue.length && this.flight.size < WINDOW) {
      const q = this.queue.shift();
      const bytes = pack(DATA, this.sid, q.seq, q.flags, q.data);
      this.flight.set(q.seq, { bytes, size: q.data.length, at: Date.now(), tries: 0 });
      this.put(bytes);
    }
  }

  // string -> text message, ArrayBuffer/typed array -> binary message (like RTCDataChannel)
  send(data) {
    if (this.readyState !== 'open') throw new Error('relay not open');
    const bin = typeof data !== 'string';
    const u8 = !bin ? te.encode(data) : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    const n = Math.max(1, Math.ceil(u8.length / FRAME));
    for (let i = 0; i < n; i++) {
      const part = u8.slice(i * FRAME, (i + 1) * FRAME); // copy: the caller may reuse its buffer
      const flags = (i === n - 1 ? 1 : 0) | (bin ? 2 : 0);
      this.queue.push({ seq: this.next++, data: part, flags });
      this.bufferedAmount += part.length;
    }
    this.pump();
  }

  shut() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    clearInterval(this.timer);
    clearTimeout(this.ackTimer);
    this.inner.removeEventListener('message', this.listener);
    this.dispatchEvent(new Event('close'));
    this.onclose?.();
  }

  close() { this.shut(); }
}

// Starts the relay when the direct path does not come up: ICE failed, or still connecting after
// `after` ms. Or when the peer starts it first (its OPEN arrives). Once the relay is the channel,
// a late direct channel does not replace it (Peer.wire): switching mid-response would reorder.
// Returns { chan, stop }. `forced` (ms = 0) starts it at once (tests).
export function relayFallback(peer, inner, key, { after = 15000, onlog = () => {}, ...opts } = {}) {
  const chan = new RelayChannel(inner, key, opts);
  let timer;
  const go = (why, woken = false) => {
    // Woken by the peer's OPEN: join even if our direct channel is open (the peer can only be
    // reached this way). Own trigger: only if the direct channel is not open.
    if (chan.active || chan.readyState === 'closed') return;
    if (!woken && peer.dc?.readyState === 'open') return;
    onlog(`relay: ${why}`);
    chan.activate();
    peer.wire(chan);
  };
  chan.onwake = () => go('peer started it', true);
  const onstate = () => {
    const st = peer.pc.connectionState;
    if (st === 'failed') go('direct path failed');
    else if (st === 'connecting') {
      timer ??= setTimeout(() => go(`no direct path after ${after / 1000} s`), after);
    } else if (st === 'connected') { clearTimeout(timer); timer = undefined; }
  };
  peer.pc.addEventListener('connectionstatechange', onstate);
  if (after <= 0) go('forced');
  return {
    chan,
    stop: () => {
      clearTimeout(timer);
      peer.pc.removeEventListener('connectionstatechange', onstate);
      chan.close();
    },
  };
}
