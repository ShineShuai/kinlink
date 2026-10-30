import { openSession } from './src/session.js';
import { supervise } from './src/supervise.js';
import { execViaPort } from './src/ext-port.js';
import { CFG } from './src/diag.js';
import { rbWord } from './src/remote.js';

// Background Host: one supervised session, status and log for the app tab (messages).
const st = { sig: 'signaling: -', link: 'new', peer: 'peer: not connected' };
let remoteOn = false;
const rbText = () => rbWord({ allowed: remoteOn, using: st.using });
const status = () => `${st.sig} | link: ${st.link} | ${st.peer} | ${rbText()} | background host`;
const lines = [];
const tell = (m) => chrome.runtime.sendMessage({ kl: 'bgstat', ...m }).catch(() => {});
const log = (m) => {
  const line = `${new Date().toISOString().slice(11, 23)} ${m}`;
  lines.push(line);
  if (lines.length > 300) lines.shift();
  tell({ line, status: status() });
};
let words = ''; // link and remote words last written to the log
const onstate = (p) => {
  Object.assign(st, p);
  tell({ status: status() });
  const now = `link: ${st.link} | ${rbText()}`;
  if (now !== words && st.link !== 'new') log(words = now);
};

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (sender.id !== chrome.runtime.id || m?.kl !== 'who') return false;
  reply({ status: status(), log: lines.join('\n') });
  return false;
});

const cfg = await chrome.runtime.sendMessage({ kl: 'ready' });
if (cfg?.on) {
  remoteOn = !!cfg.remote;
  supervise(() => openSession({
    secret: cfg.secret,
    brokers: cfg.brokers ?? CFG.mqtt,
    stun: CFG.stun, // probed: the ones that answer are used (pickStun)
    signaling: 'mqtt',
    relayAfter: 8000,
    enabled: () => true,
    exec: execViaPort,
    remote: { enabled: () => !!cfg.remote, connect: () => chrome.runtime.connect({ name: 'rb' }) },
    onlog: log,
    onstate,
    onhello: (m) => onstate({
      peer: `peer: build ${m.build}, serving ${m.serving ? 'yes' : 'no'}`,
    }),
  }), { onlog: log });
}
