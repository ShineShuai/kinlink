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
  const sigKey = await crypto.subtle.deriveKey(
    p('kinlink/signaling'), ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { room: hex(room), sigKey }; // TODO: per-direction session keys
}

// Random 96-bit IV: fine for a handful of signaling messages per key.
export async function sealText(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(text));
  return b64u(Uint8Array.from([...iv, ...new Uint8Array(ct)]));
}

export async function openText(key, s) {
  const b = unb64u(s);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b.slice(0, 12) }, key, b.slice(12));
  return td.decode(pt);
}

// Wraps any adapter: untrusted medium in, authenticated plaintext out.
// The SDP carries the DTLS fingerprint, so opening it also pins the peer's cert.
export class SealedAdapter extends SignalingAdapter {
  constructor(inner, key) {
    super();
    this.inner = inner;
    this.key = key;
    inner.addEventListener('message', async (e) => {
      try { this.emit(await openText(key, e.data)); } catch { /* forged or foreign: drop */ }
    });
  }
  open() { return this.inner.open(); }
  async send(text) { await this.inner.send(await sealText(this.key, text)); }
  close() { return this.inner.close(); }
}
