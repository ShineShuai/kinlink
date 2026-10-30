import { SignalingAdapter } from './signaling.js';

const te = new TextEncoder();
const td = new TextDecoder();
const b64u = (u8) => btoa(String.fromCharCode(...u8))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(
  atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

// 128-bit pairing secret. Share via URL fragment / QR; never sent to a server.
export const newSecret = () => b64u(crypto.getRandomValues(new Uint8Array(16)));

// HKDF-SHA256, one domain-separation label per output.
export async function derive(secret) {
  const ikm = await crypto.subtle.importKey(
    'raw', unb64u(secret), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const p = (info) => ({
    name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: te.encode(info),
  });
  const room = new Uint8Array(await crypto.subtle.deriveBits(p('kinlink/room'), ikm, 128));
  const key = (info) => crypto.subtle.deriveKey(
    p(info), ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return {
    room: hex(room), sigKey: await key('kinlink/signaling'), relayKey: await key('kinlink/relay'),
  }; // TODO: per-direction session keys
}

// Random 96-bit IV: fine up to ~2^32 messages per key (signaling and relay frames).
export async function sealBytes(key, u8) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, u8));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64u(out);
}

export async function openBytes(key, s) {
  const b = unb64u(s);
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b.slice(0, 12) }, key, b.slice(12)));
}

export const sealText = (key, text) => sealBytes(key, te.encode(text));
export const openText = async (key, s) => td.decode(await openBytes(key, s));

// Wraps any adapter: untrusted medium in, authenticated plaintext out.
// The SDP carries the DTLS fingerprint, so opening it also pins the peer's cert.
// Every send is sealed anew (fresh IV), but the one sealed text goes to all brokers, and brokers of
// one cluster hand it back (also to its sender). Identical sealed text = the same message: it is
// delivered once. A real retry has a new IV, so it still arrives. Messages come in order, one at
// a time (the peer must not handle two copies of an answer at once).
export class SealedAdapter extends SignalingAdapter {
  constructor(inner, key) {
    super();
    this.inner = inner;
    this.key = key;
    this.seen = new Set();
    this.tail = Promise.resolve();
    inner.addEventListener('message', (e) => {
      const s = e.data;
      if (this.seen.has(s)) return;
      this.seen.add(s);
      if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value);
      const mine = openText(key, s).catch(() => null); // forged or foreign: dropped below
      this.tail = this.tail.then(async () => {
        const text = await mine;
        if (text !== null) this.emit(text);
      });
    });
  }
  open() { return this.inner.open(); }
  async send(text) {
    const s = await sealText(this.key, text);
    this.seen.add(s); // our own copy, when a broker hands it back
    await this.inner.send(s);
  }
  close() { return this.inner.close(); }
}
