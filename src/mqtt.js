import { SignalingAdapter } from './signaling.js';

const te = new TextEncoder();
const td = new TextDecoder();
const str = (s) => { const b = te.encode(s); return [b.length >> 8, b.length & 255, ...b]; };
const varint = (n) => {
  const o = [];
  do { const d = n % 128; n = Math.floor(n / 128); o.push(n ? d | 128 : d); } while (n);
  return o;
};
const pkt = (hdr, body) => Uint8Array.from([hdr, ...varint(body.length), ...body]);

// Minimal MQTT 3.1.1: CONNECT, SUBSCRIBE and PUBLISH at QoS 0, no retain.
// Both peers must be online (subscribe before the other publishes).
// Payload = 8-byte node id + text; the id filters the broker's echo of our own publishes.
export class MqttWssAdapter extends SignalingAdapter {
  buf = new Uint8Array(0);
  id = crypto.getRandomValues(new Uint8Array(8));

  constructor(url, topic) {
    super();
    this.url = url;
    this.topic = topic;
  }

  open(timeoutMs = 8000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { rej(new Error('timeout')); this.ws.close(); }, timeoutMs);
      this.ready = {
        res: () => { clearTimeout(t); res(); },
        rej: (e) => { clearTimeout(t); rej(e); },
      };
      const ws = (this.ws = new WebSocket(this.url, 'mqtt'));
      ws.binaryType = 'arraybuffer';
      ws.onerror = () => this.ready.rej(new Error('unreachable'));
      ws.onclose = () => {
        clearInterval(this.keepalive);
        this.ready.rej(new Error('closed'));
        this.dispatchEvent(new Event('close'));
      };
      ws.onmessage = (e) => this.parse(new Uint8Array(e.data));
      ws.onopen = () => {
        const cid = `kl-${Math.random().toString(16).slice(2, 10)}`;
        ws.send(pkt(0x10, [...str('MQTT'), 4, 2, 0, 60, ...str(cid)])); // clean, 60 s
        this.keepalive = setInterval(() => ws.send(Uint8Array.of(0xc0, 0)), 30000);
      };
    });
  }

  parse(chunk) {
    const b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf);
    b.set(chunk, this.buf.length);
    let i = 0;
    while (i + 2 <= b.length) {
      let len = 0, mul = 1, j = i + 1, d;
      do { d = b[j++]; len += (d & 127) * mul; mul *= 128; } while ((d & 128) && j < b.length);
      if ((d & 128) || j + len > b.length) break; // incomplete packet, wait for more
      this.packet(b[i], b.subarray(j, j + len));
      i = j + len;
    }
    this.buf = b.slice(i);
  }

  packet(hdr, body) {
    const { res, rej } = this.ready;
    switch (hdr >> 4) {
      case 2: // CONNACK
        if (body[1]) return rej(new Error(`connack ${body[1]}`));
        this.ws.send(pkt(0x82, [0, 1, ...str(this.topic), 0]));
        break;
      case 9: // SUBACK
        if (body[2] === 0x80) rej(new Error('suback refused')); else res();
        break;
      case 3: { // PUBLISH
        const p = body.subarray(2 + ((body[0] << 8) | body[1]));
        if (p.length < 8 || p.subarray(0, 8).every((v, k) => v === this.id[k])) break;
        this.emit(td.decode(p.subarray(8)));
        break;
      }
    }
  }

  async send(text) {
    this.ws.send(pkt(0x30, [...str(this.topic), ...this.id, ...te.encode(text)]));
  }

  async close() {
    clearInterval(this.keepalive);
    if (this.ws.readyState === 1) this.ws.send(Uint8Array.of(0xe0, 0)); // DISCONNECT
    this.ws.close();
  }
}
