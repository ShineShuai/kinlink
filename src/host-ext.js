// Host executor for the extension: ONE request hop, never following redirects.
// fetch() cannot set Cookie/Referer/Origin and hides Set-Cookie and the redirect target, so:
//  - declarativeNetRequest session rules set Cookie/Referer/Origin for exactly this URL,
//  - webRequest.onHeadersReceived reports status, Set-Cookie and Location of the hop.
// The Client keeps the cookie jar and follows redirects (src/browse.js).
// Runs in the service worker only (background.js); pages reach it through src/ext-port.js.
let nextRule = 1;
const taps = new Map(); // "METHOD url" -> [{ status, setCookies, location }]
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
}

async function takeTap(key) {
  for (let i = 0; i < 40; i++) { // the event can arrive just after fetch() resolves
    const list = taps.get(key);
    if (list?.length) {
      const t = list.shift();
      if (!list.length) taps.delete(key);
      return t;
    }
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
    const tap = await takeTap(`${method} ${url}`);
    const redirect = res.type === 'opaqueredirect';
    return {
      status: tap?.status ?? res.status,
      url,
      headers: redirect ? [] : [...res.headers],
      body: redirect ? null : res.body,
      setCookies: tap?.setCookies ?? [],
      location: tap?.location,
    };
  } finally {
    if (requestHeaders.length) await rules.updateSessionRules({ removeRuleIds: [id] });
  }
}
