// Host executor for the extension: ONE request hop, never following redirects.
// fetch() cannot set Cookie/Referer/Origin and hides Set-Cookie and the redirect target, so:
//  - declarativeNetRequest session rules set Cookie/Referer/Origin for exactly this URL,
//  - webRequest.onHeadersReceived reports status, Set-Cookie and Location of the hop.
// The Client keeps the cookie jar and follows redirects (src/browse.js).
// Runs in the service worker only (background.js); pages reach it through src/ext-port.js.
let nextRule = 1;
const taps = new Map(); // "METHOD url" -> [{ status, setCookies, location }]
// Redirects without a headers event: with extraHeaders Chrome reports an internal redirect (HSTS
// http -> https, 307) only through onBeforeRedirect, and fetch() shows it as an opaque redirect.
const hops = new Map(); // "METHOD url" -> [{ status, location }]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tapped = false;
// Registered on first use, i.e. after the optional host permission has been granted.
function ensureTap() {
  if (tapped) return;
  tapped = true;
  startTap();
}

function startTap() {
  chrome.webRequest.onHeadersReceived.addListener((d) => {
    if (d.initiator !== location.origin || d.type !== 'xmlhttprequest') return;
    const all = (n) => (d.responseHeaders ?? [])
      .filter((h) => h.name.toLowerCase() === n).map((h) => h.value);
    const key = `${d.method} ${d.url}`;
    taps.set(key, [...(taps.get(key) ?? []),
      { status: d.statusCode, setCookies: all('set-cookie'), location: all('location')[0] }]);
  }, { urls: ['<all_urls>'] }, ['responseHeaders', 'extraHeaders']);
  chrome.webRequest.onBeforeRedirect.addListener((d) => {
    if (d.initiator !== location.origin || d.type !== 'xmlhttprequest') return;
    const key = `${d.method} ${d.url}`;
    hops.set(key, [...(hops.get(key) ?? []), { status: d.statusCode, location: d.redirectUrl }]);
  }, { urls: ['<all_urls>'] });
}

const shift = (map, key) => {
  const list = map.get(key);
  const t = list?.shift();
  if (list && !list.length) map.delete(key);
  return t;
};

async function takeTap(key, redirect) {
  for (let i = 0; i < 40; i++) { // the event can arrive just after fetch() resolves
    if (taps.get(key)?.length) {
      if (redirect) shift(hops, key); // same redirect, the headers event has more (Set-Cookie)
      return shift(taps, key);
    }
    const h = redirect && shift(hops, key); // events of one request arrive in order
    if (h) return { status: h.status, setCookies: [], location: h.location };
    await sleep(25);
  }
  return null;
}

export async function exec(req) {
  const { url, method = 'GET', headers = {}, body, cookie, referer, origin, signal } = req;
  ensureTap();
  const id = nextRule++;
  const requestHeaders = Object.entries({ cookie, referer, origin }).filter(([, v]) => v)
    .map(([header, value]) => ({ header, operation: 'set', value }));
  const rules = chrome.declarativeNetRequest;
  if (requestHeaders.length) {
    await rules.updateSessionRules({ addRules: [{
      id, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders },
      condition: { urlFilter: `|${url}|`, resourceTypes: ['xmlhttprequest'], initiatorDomains: [chrome.runtime.id] },
    }] });
  }
  try {
    const res = await fetch(url, {
      method, headers, body, signal, credentials: 'omit', cache: 'no-store', redirect: 'manual',
    });
    const redirect = res.type === 'opaqueredirect';
    const tap = await takeTap(`${method} ${url}`, redirect);
    let status = tap?.status ?? res.status;
    let loc = tap?.location;
    if (redirect && !loc && url.startsWith('http:')) { // no event at all: an HSTS upgrade
      status = 307;
      loc = url.replace(/^http:/, 'https:');
    }
    if (!(status >= 100 && status <= 599)) throw new Error('redirect target hidden by the browser');
    return {
      status,
      url,
      headers: redirect ? [] : [...res.headers],
      body: redirect ? null : res.body,
      setCookies: tap?.setCookies ?? [],
      location: loc,
    };
  } finally {
    if (requestHeaders.length) await rules.updateSessionRules({ removeRuleIds: [id] });
  }
}
