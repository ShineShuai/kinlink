import { PERMS, cdpInput, size, urlProblem } from './remote.js';

// Remote browser, service worker side: a popup window of the Host's browser, driven with
// chrome.debugger (screencast out, input in). Runs in the worker only.
// Safety: incognito window (own cookie jar: the Client must not reach the Host's logins), http(s)
// to non-private hosts only (every request of the tab, via declarativeNetRequest), downloads
// denied, extra windows closed. The Chrome debugging banner stays visible to the Host user.
const TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'media', 'websocket', 'other'];
const SCHEME = '^(https?|wss?)://([^/@]*@)?';
// Several small rules: one big regex exceeds the 2 KB compiled limit of declarativeNetRequest.
export const PRIVATE = [
  `${SCHEME}(localhost|[^/:@]*\\.(localhost|local|internal))([:/?#]|$)`,
  `${SCHEME}(127|10|0)\\.`,
  `${SCHEME}(169\\.254|192\\.168)\\.`,
  `${SCHEME}172\\.(1[6-9]|2[0-9]|3[01])\\.`,
  `${SCHEME}100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.`,
  `${SCHEME}\\[(::1?\\]|::ffff:|f[cd]|fe[89ab])`,
];

let active = null; // one remote browser per Host
let ruleId = 1000000; // each session takes PRIVATE.length ids
const cdp = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);

async function start(m, send) {
  if (!(await chrome.permissions.contains({ permissions: PERMS }))) {
    throw new Error('host: the remote browser permissions are not granted');
  }
  const why = urlProblem(m.url);
  if (why) throw new Error(`blocked: ${why}`);
  const { remote } = await chrome.storage.local.get('remote');
  const incognito = !remote?.unsafeProfile; // unsafeProfile: dev/tests only (sees the logins)
  if (incognito && !(await chrome.extension.isAllowedIncognitoAccess())) {
    throw new Error('host: turn on "Allow in Incognito" for Kinlink in chrome://extensions: the '
      + 'remote browser runs there, so it cannot see your logins');
  }
  await active?.close();
  const q = Math.min(90, Math.max(20, Math.round(m.q) || 60));
  const s = { ...size(m.w, m.h), q, closed: false };
  active = s;
  const rules = PRIVATE.map((_, i) => ruleId + i);
  ruleId += PRIVATE.length;
  const un = []; // listener removers
  const listen = (ev, f) => { ev.addListener(f); un.push(() => ev.removeListener(f)); };
  s.close = async () => {
    if (s.closed) return;
    s.closed = true;
    if (active === s) active = null;
    un.forEach((f) => f());
    await cdp(s.tabId, 'Page.stopScreencast').catch(() => {});
    await chrome.debugger.detach({ tabId: s.tabId }).catch(() => {});
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules }).catch(() => {});
    await chrome.windows.remove(s.winId).catch(() => {});
  };
  const gone = () => { send({ closed: true }); s.close(); };
  const check = async (url) => { // the tab must stay within the policy (redirects, scripts)
    if (!url || url === 'about:blank' || url.startsWith('chrome-error:')) return;
    const bad = urlProblem(url);
    if (!bad) return;
    await cdp(s.tabId, 'Page.navigate', { url: 'about:blank' }).catch(() => {});
    send({ error: `blocked: ${bad}` });
  };
  const nav = (url) => cdp(s.tabId, 'Page.navigate', { url });
  const cast = () => cdp(s.tabId, 'Page.startScreencast', {
    format: 'jpeg', quality: s.q, maxWidth: s.w, maxHeight: s.h, everyNthFrame: 1,
  });
  const view = () => cdp(s.tabId, 'Emulation.setDeviceMetricsOverride', {
    width: s.w, height: s.h, deviceScaleFactor: 1, mobile: false,
  });

  try {
    const win = await chrome.windows.create({
      url: 'about:blank', incognito, type: 'popup', focused: false,
      width: s.w + 16, height: s.h + 120,
    });
    s.winId = win.id;
    s.tabId = win.tabs[0].id;
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: PRIVATE.map((re, i) => ({
      id: rules[i], priority: 1, action: { type: 'block' },
      condition: { regexFilter: re, tabIds: [s.tabId], resourceTypes: TYPES },
    })) });
    listen(chrome.debugger.onEvent, (src, method, p) => {
      if (src.tabId !== s.tabId) return;
      if (method === 'Page.screencastFrame') {
        cdp(s.tabId, 'Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
        send({ frame: p.data, w: s.w, h: s.h });
      } else if (method === 'Page.frameNavigated' && !p.frame.parentId) check(p.frame.url);
    });
    listen(chrome.debugger.onDetach, (src) => src.tabId === s.tabId && gone());
    listen(chrome.windows.onRemoved, (id) => id === s.winId && gone());
    listen(chrome.tabs.onUpdated, (id, info, tab) => {
      if (id !== s.tabId || !(info.url || info.title || info.status)) return;
      send({ meta: { url: tab.url, title: tab.title, loading: tab.status === 'loading' } });
    });
    // Popups and target=_blank open in the Host's normal window, without an opener on the tab, and
    // outside the rules above: close that tab, navigate the remote tab instead.
    listen(chrome.webNavigation.onCreatedNavigationTarget, (d) => {
      if (d.sourceTabId !== s.tabId) return;
      chrome.tabs.remove(d.tabId).catch(() => {});
      if (d.url && !urlProblem(d.url)) nav(d.url).catch(() => {});
    });
    await chrome.debugger.attach({ tabId: s.tabId }, '1.3');
    await cdp(s.tabId, 'Page.enable');
    await cdp(s.tabId, 'Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    await cdp(s.tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await view();
    await cast();
    await nav(m.url);
  } catch (e) {
    await s.close();
    throw e;
  }

  s.nav = async ({ a, url }) => {
    if (a === 'go') {
      const bad = urlProblem(url);
      if (bad) throw new Error(`blocked: ${bad}`);
      await nav(url);
    } else if (a === 'reload') {
      await cdp(s.tabId, 'Page.reload');
    } else if (a === 'back' || a === 'forward') {
      const h = await cdp(s.tabId, 'Page.getNavigationHistory');
      const e = h.entries[h.currentIndex + (a === 'back' ? -1 : 1)];
      if (e) await cdp(s.tabId, 'Page.navigateToHistoryEntry', { entryId: e.id });
    }
  };
  s.resize = async (d) => {
    Object.assign(s, size(d.w, d.h));
    await cdp(s.tabId, 'Page.stopScreencast');
    await view();
    await cast();
  };
  return s;
}

// One Port from the page that owns the peer; closing the port closes the remote browser.
export function servePortRemote(port) {
  let s = null;
  let left = false;
  const send = (m) => { try { port.postMessage(m); } catch { /* the page is gone */ } };
  port.onDisconnect.addListener(() => { left = true; s?.close(); });
  port.onMessage.addListener(async (m) => {
    try {
      if (m.op === 'open') {
        s = await start(m, send);
        if (left) s.close();
      } else if (!s) {
        return;
      } else if (m.op === 'input') {
        const c = cdpInput(m.ev, s);
        if (c) await cdp(s.tabId, c.method, c.params);
      } else if (m.op === 'nav') {
        await s.nav(m);
      } else if (m.op === 'size') {
        await s.resize(m);
      }
    } catch (e) {
      send({ error: e.message });
    }
  });
}
