import { openBytes, sealBytes } from './crypto.js';

// Fallback transport when WebRTC finds no path (CGNAT, same NAT, UDP blocked): sealed frames
// over the signaling brokers. The medium is QoS 0 and may lose, duplicate and reorder, so this
// is a small ARQ: sequence numbers, cumulative acks, a send window, retransmit with backoff.
// RelayChannel mimics the RTCDataChannel subset that Peer and proxy.js use.
//
// Load: a frame goes to ONE broker, the one the peer's last frame came from (pref: the peer is
// subscribed there). Retransmits, OPEN and keepalives go to all brokers: a broker that silently
// drops costs one RTO, not the link. Without a pref yet (handshake) everything goes to all.
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
  held = 0; // payload bytes queued or unacked on the relay
  alt = null; // a direct channel that came up after the relay started (adopt)
  useAlt = false;
  readyState = 'connecting';
  active = false; // false: only listening; a peer's OPEN wakes it (see onwake)
  sid = crypto.getRandomValues(new Uint32Array(1))[0];
  peerSid = null;
  pref = null; // name of the broker the peer's last frame came from (FanoutAdapter), or null
  echoed = 0;
  seen = new Set(); // recent frame texts (see fresh)
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

  constructor(inner, key, o = {}) {
    super();
    const { tickMs = 500, rtoMs = 1000, openMs = 60000, keepMs = 15000, send, onlog } = o;
    this.onlog = onlog;
    Object.assign(this, { inner, key, tickMs, rtoMs, openMs, keepMs });
    this.lastSent = 0;
    this.xmit = send ?? ((text, via) => inner.send(text, via));
    this.listener = (e) => this.hear(e.data, e.via);
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

  // Every frame reaches us several times: once per connected broker, and brokers of one cluster
  // hand us our own publishes too. Identical text = the same frame: drop it before decrypting.
  fresh(text) {
    if (this.seen.has(text)) return false;
    this.seen.add(text);
    if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value);
    return true;
  }

  async put(bytes, all = false) { // best effort: loss is handled by retransmission
    this.lastSent = Date.now();
    try {
      const text = await sealBytes(this.key, bytes);
      this.fresh(text); // our own copy, when it comes back
      await this.xmit(text, all ? undefined : this.pref ?? undefined);
    } catch { /* no broker up right now */ }
  }

  tick() {
    const now = Date.now();
    if (this.readyState === 'connecting') {
      if (now - this.t0 > this.openMs) return this.shut();
      if (now - this.lastOpen >= 2 * this.tickMs) {
        this.lastOpen = now;
        this.put(pack(OPEN, this.sid, 0), true);
      }
    }
    // Keepalive: an idle side that lost its peer (it restarted) finds out: the new session sees a
    // frame it does not know, joins and sends OPEN, we reset and re-open.
    if (this.readyState === 'open' && now - this.lastSent >= this.keepMs) {
      this.put(pack(ACK, this.sid, this.expect), true);
    }
    let n = 0;
    for (const [seq, fl] of this.flight) {
      if (now - fl.at < Math.min(this.rtoMs * 2 ** fl.tries, 8 * this.rtoMs)) continue;
      if (fl.tries >= 10) return this.shut();
      fl.tries++;
      fl.at = now;
      this.put(fl.bytes, true);
      if (++n >= 4) break; // oldest first; the rest wait for the next tick
    }
  }

  async hear(text, via) {
    if (this.readyState === 'closed' || !this.fresh(text)) return;
    let f;
    try { f = unpack(await openBytes(this.key, text)); } catch { return; } // foreign or forged
    if (f.sid === this.sid) { // MQTT brokers deliver a message to its publisher too
      if (!this.echoed++) this.onlog?.('relay: ignoring our own frames echoed by the broker');
      return;
    }
    if (this.old.has(f.sid)) return;
    if (via) this.pref = via; // first copy of a frame of the peer: its fastest broker
    if (!this.active) { // the peer uses the relay: join it. Frames other than OPEN come from a
      this.onwake?.(); // session that lost us (we restarted): joining sends our OPEN, so it resets
      if (!this.active) return;
      if (f.type !== OPEN) return;
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
    this.next = this.expect = this.held = 0;
  }

  opened() {
    this.onlog?.(`relay: open with peer ${this.peerSid.toString(16)}`);
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
    const before = this.held;
    for (const [seq, fl] of this.flight) {
      if (seq >= upTo) break; // Map keeps insertion order = seq order
      this.flight.delete(seq);
      this.held -= fl.size;
    }
    this.pump();
    if (before > this.bufferedAmountLowThreshold
      && this.held <= this.bufferedAmountLowThreshold) {
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

  get bufferedAmount() { return this.useAlt ? this.alt.bufferedAmount : this.held; }

  // A direct channel that opened after the relay started (Peer.wire). It takes over sending once
  // every relay frame is acked: nothing of ours can then still arrive late, so messages cannot
  // be reordered across the switch. Receiving works on both channels all the time. If it closes,
  // sending falls back to the relay.
  adopt(dc) {
    this.alt = dc;
    dc.addEventListener?.('bufferedamountlow', () => {
      if (this.useAlt) this.dispatchEvent(new Event('bufferedamountlow'));
    });
    dc.addEventListener?.('close', () => this.route());
  }

  route() { // which channel carries the next message
    const ok = this.alt?.readyState === 'open';
    const want = ok && (this.useAlt || (!this.queue.length && !this.flight.size));
    if (want !== this.useAlt) {
      this.useAlt = want;
      this.dispatchEvent(new Event('switch'));
    }
    return want;
  }

  // string -> text message, ArrayBuffer/typed array -> binary message (like RTCDataChannel)
  send(data) {
    if (this.readyState !== 'open') throw new Error('relay not open');
    if (this.route()) return this.alt.send(data);
    const bin = typeof data !== 'string';
    const u8 = !bin ? te.encode(data) : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    const n = Math.max(1, Math.ceil(u8.length / FRAME));
    for (let i = 0; i < n; i++) {
      const part = u8.slice(i * FRAME, (i + 1) * FRAME); // copy: the caller may reuse its buffer
      const flags = (i === n - 1 ? 1 : 0) | (bin ? 2 : 0);
      this.queue.push({ seq: this.next++, data: part, flags });
      this.held += part.length;
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
// `after` ms. Or when the peer starts it first (its OPEN arrives). The relay stays peer.dc; a
// direct channel that comes up later is adopted by it (RelayChannel.adopt).
// Returns { chan, stop }. `after` = 0 starts it at once (tests).
// `canWake()` false: this session is over (a restart is pending), do not let the peer join it.
export function relayFallback(peer, inner, key, opts = {}) {
  const { after = 8000, onlog = () => {}, canWake = () => true, ...rest } = opts;
  const chan = new RelayChannel(inner, key, { ...rest, onlog });
  let timer;
  const go = (why, woken = false) => {
    // Woken by the peer's OPEN: join even if our direct channel is open (the peer can only be
    // reached this way). Own trigger: only if the direct channel is not open.
    if (chan.active || chan.readyState === 'closed') return;
    if (woken ? !canWake() : peer.dc?.readyState === 'open') return;
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
