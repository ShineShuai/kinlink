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

// Several adapters at once, e.g. several brokers: send on all that are up, merge what arrives.
// open() resolves as soon as one is up; the others join later. Duplicates are expected
// (same message via two brokers): the Peer handles them.
export class FanoutAdapter extends SignalingAdapter {
  onlog = () => {};
  up = new Set();

  constructor(named) { // [[name, adapter], ...]
    super();
    this.named = named;
    for (const [, a] of named) {
      a.addEventListener('message', (e) => this.emit(e.data));
      a.addEventListener('close', () => { this.up.delete(a); this.changed(); });
    }
  }

  changed() { this.dispatchEvent(new Event('state')); }
  status() { return `${this.up.size}/${this.named.length} signaling servers`; }

  open() {
    const errs = [];
    return new Promise((res, rej) => {
      for (const [name, a] of this.named) {
        a.open().then(() => {
          this.up.add(a);
          this.onlog(`signaling ${name}: connected`);
          this.changed();
          res();
        }, (e) => {
          errs.push(name);
          this.onlog(`signaling ${name}: ${e.message}`);
          this.changed();
          if (errs.length === this.named.length) rej(new Error('no signaling server reachable'));
        });
      }
    });
  }

  async send(text) {
    if (!this.up.size) throw new Error('no signaling server connected');
    await Promise.allSettled([...this.up].map((a) => a.send(text)));
  }

  async close() { await Promise.allSettled(this.named.map(([, a]) => a.close())); }
}

// Planned: WssAdapter (own relay), NostrAdapter; same three methods as above.
