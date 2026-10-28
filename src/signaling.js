// Signaling adapter contract: opaque string messages, best-effort delivery.
// Emits MessageEvent 'message' (data: string). Payload sealing (AEAD) is done upstream.
export class SignalingAdapter extends EventTarget {
  async open() {}
  async send(_text) { throw new Error('not implemented'); }
  async close() {}
  emit(text) { this.dispatchEvent(new MessageEvent('message', { data: text })); }
}

// Copy/paste channel: send() hands text to the UI, feed() injects pasted text.
export class ManualAdapter extends SignalingAdapter {
  constructor(onOutput) { super(); this.onOutput = onOutput; }
  async send(text) { this.onOutput(text); }
  feed(text) { this.emit(text); }
}

// Same-origin tabs, zero clicks. Test only.
export class BroadcastAdapter extends SignalingAdapter {
  constructor(name = 'kinlink') {
    super();
    this.ch = new BroadcastChannel(name);
    this.ch.onmessage = (e) => this.emit(e.data);
  }
  async send(text) { this.ch.postMessage(text); }
  async close() { this.ch.close(); }
}

// Planned: WssAdapter (own relay), NostrAdapter; same three methods as above.
