import {
  buildConnectUrl,
  buildLaunchUrl,
  extractLaunchHref,
  LOGIN_URL,
  MOODLE_ORIGIN,
  randomPassport,
} from './lib/capture.js';

// Storage (chrome.storage.local): serviceUrl, lastSync {at, result}. The launch token is never stored or logged.
const ALARM = 'wmm-refresh';
const REFRESH_MINUTES = 12 * 60;
const TAB_CAPTURE_TIMEOUT_MS = 20000;
const SIGNIN_TIMEOUT_MS = 10 * 60 * 1000;

const getState = () => chrome.storage.local.get(['serviceUrl', 'lastSync']);

async function setResult(result) {
  const lastSync = { at: Date.now(), result };
  await chrome.storage.local.set({ lastSync });
  await updateBadge();
  return lastSync;
}

async function updateBadge() {
  const { serviceUrl, lastSync } = await getState();
  let text = '';
  let title = chrome.i18n.getMessage('extName');
  if (!serviceUrl) {
    text = '!';
    title = chrome.i18n.getMessage('badgeNotConfigured');
  } else if (lastSync && (lastSync.result === 'signin_required' || lastSync.result === 'unknown_user')) {
    text = '!';
    title = chrome.i18n.getMessage(lastSync.result === 'signin_required' ? 'badgeSigninNeeded' : 'badgeNotConnected');
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: '#B3261E' });
  await chrome.action.setTitle({ title });
}

async function hasServicePermission(serviceUrl) {
  return chrome.permissions.contains({ origins: [`${serviceUrl}/*`] });
}

/** Background fetch capture. Returns the launch href or null (not signed in / no cookies). */
async function captureViaFetch(passport) {
  try {
    const res = await fetch(buildLaunchUrl(passport), {
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return extractLaunchHref(await res.text());
  } catch {
    return null;
  }
}

// Fallback: open launch.php in an inactive tab; content-launch.js reports the link.
const pendingTabs = new Map(); // tabId -> resolve

async function captureViaTab(passport) {
  const url = `${buildLaunchUrl(passport)}&wmmExt=1`;
  const tab = await chrome.tabs.create({ url, active: false });
  return new Promise((resolve) => {
    const finish = (href) => {
      clearTimeout(timer);
      pendingTabs.delete(tab.id);
      chrome.tabs.remove(tab.id).catch(() => {});
      resolve(href ? extractLaunchHref(`<a id="launchapp" href="${href}">`) : null);
    };
    const timer = setTimeout(() => finish(null), TAB_CAPTURE_TIMEOUT_MS);
    pendingTabs.set(tab.id, finish);
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const finish = pendingTabs.get(tabId);
  if (finish) finish(null);
});

/** Waits until the user reaches a signed-in Moodle page in the given tab. */
function waitForSignIn(tabId) {
  return new Promise((resolve) => {
    const done = (ok) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(ok);
    };
    const onUpdated = (id, info, tab) => {
      if (id !== tabId || info.status !== 'complete' || !tab.url) return;
      try {
        const u = new URL(tab.url);
        if (u.origin === MOODLE_ORIGIN && u.pathname.startsWith('/my/')) done(true);
      } catch {
        /* ignore */
      }
    };
    const onRemoved = (id) => {
      if (id === tabId) done(false);
    };
    const timer = setTimeout(() => done(false), SIGNIN_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

/** Silent: fetch only. Interactive: fetch → tab fallback → sign-in tab → retry. */
async function capture(passport, { interactive }) {
  let href = await captureViaFetch(passport);
  if (href || !interactive) return { href, signinTabId: null };
  href = await captureViaTab(passport);
  if (href) return { href, signinTabId: null };
  const tab = await chrome.tabs.create({ url: LOGIN_URL, active: true });
  if (!(await waitForSignIn(tab.id))) return { href: null, signinTabId: null };
  href = (await captureViaFetch(passport)) || (await captureViaTab(passport));
  return { href, signinTabId: tab.id };
}

/** Exchanges the launch link for a short-lived single-use code (§11). Returns null on failure. */
async function createHandoff(serviceUrl, passport, launch) {
  try {
    const res = await fetch(`${serviceUrl}/api/connect/handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ launch, via: 'extension', passport }),
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return typeof body?.code === 'string' && body.code ? body.code : null;
  } catch {
    return null;
  }
}

async function connect() {
  const { serviceUrl } = await getState();
  if (!serviceUrl) {
    await chrome.runtime.openOptionsPage();
    return { ok: false, error: 'not_configured' };
  }
  const passport = randomPassport();
  const { href, signinTabId } = await capture(passport, { interactive: true });
  if (!href) {
    await setResult('signin_required');
    return { ok: false, error: 'signin_required' };
  }
  const code = await createHandoff(serviceUrl, passport, href);
  if (!code) {
    await setResult('server_error');
    return { ok: false, error: 'server_error' };
  }
  const url = buildConnectUrl(serviceUrl, code);
  if (signinTabId != null)
    await chrome.tabs.update(signinTabId, { url, active: true }).catch(() => chrome.tabs.create({ url }));
  else await chrome.tabs.create({ url });
  await setResult('connect_opened');
  return { ok: true };
}

let refreshing = null;
function refresh() {
  refreshing ??= doRefresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function doRefresh() {
  const { serviceUrl } = await getState();
  if (!serviceUrl) {
    await updateBadge();
    return { result: 'not_configured' };
  }
  if (!(await hasServicePermission(serviceUrl))) return setResult('permission_missing');
  const passport = randomPassport();
  const { href } = await capture(passport, { interactive: false });
  if (!href) return setResult('signin_required');
  try {
    const res = await fetch(`${serviceUrl}/api/extension/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ launch: href, passport }),
      credentials: 'omit',
      cache: 'no-store',
    });
    if (res.status === 404) return setResult('unknown_user');
    if (res.status === 429) return setResult('rate_limited');
    if (!res.ok) return setResult('server_error');
    const body = await res.json().catch(() => ({}));
    return setResult(body.status === 'unchanged' ? 'unchanged' : 'updated');
  } catch {
    return setResult('network_error');
  }
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM);
  if (!existing) await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: REFRESH_MINUTES });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await ensureAlarm();
  await updateBadge();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await updateBadge();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) refresh();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.serviceUrl) updateBadge();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return false;
  if (msg.type === 'wmm:launch-captured') {
    const finish = sender.tab && pendingTabs.get(sender.tab.id);
    if (finish) finish(typeof msg.href === 'string' ? msg.href : null);
    return false;
  }
  // Only extension pages (popup/options) may trigger actions.
  if (sender.tab) return false;
  const handlers = {
    'wmm:connect': connect,
    'wmm:refresh': refresh,
    'wmm:moodle-status': async () => ({ signedIn: Boolean(await captureViaFetch(randomPassport())) }),
  };
  const handler = handlers[msg.type];
  if (!handler) return false;
  handler().then(sendResponse, () => sendResponse({ ok: false, error: 'internal' }));
  return true;
});
