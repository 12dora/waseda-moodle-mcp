import { debounce, singleFlight } from './lib/async.js';
import { buildConnectUrl, buildLaunchUrl, extractLaunchHref, LOGIN_URL, randomPassport } from './lib/capture.js';
import { hasConsentFor } from './lib/consent.js';
import {
  createSessionWatcher,
  isSignedInAnswer,
  PROBE_BODY,
  PROBE_URL,
  refreshResult,
  SESSION_COOKIE,
} from './lib/session.js';

// Storage (chrome.storage.local): serviceUrl, consent {serviceUrl, scope, at}, lastSync {at, result}.
// chrome.storage.session: pendingSignIn {tabId, until} while Connect waits for the user to sign in to Moodle.
// The MoodleSession cookie and the launch link are read when needed; they are never stored or logged.
const ALARM = 'wmm-refresh';
const REFRESH_MINUTES = 12 * 60;
const SIGNIN_TIMEOUT_MS = 10 * 60 * 1000;
const SESSION_SETTLE_MS = 5000;
const LAUNCH_TIMEOUT_MS = 5000;

const getState = () => chrome.storage.local.get(['serviceUrl', 'consent', 'lastSync']);

/** Service URL only when the user has consented to sending the session there; otherwise null. */
async function getConsentedServiceUrl() {
  const { serviceUrl, consent } = await getState();
  return hasConsentFor(consent, serviceUrl) ? serviceUrl : null;
}

async function setResult(result) {
  const lastSync = { at: Date.now(), result };
  await chrome.storage.local.set({ lastSync });
  await updateBadge();
  return lastSync;
}

async function updateBadge() {
  const { serviceUrl, consent, lastSync } = await getState();
  let text = '';
  let title = chrome.i18n.getMessage('extName');
  if (!serviceUrl) {
    text = '!';
    title = chrome.i18n.getMessage('badgeNotConfigured');
  } else if (!hasConsentFor(consent, serviceUrl)) {
    text = '!';
    title = chrome.i18n.getMessage('badgeConsentNeeded');
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

function postJson(url, body, credentials = 'omit') {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials,
    cache: 'no-store',
  });
}

async function readSessionCookie() {
  const cookie = await chrome.cookies.get(SESSION_COOKIE);
  return cookie?.value || null;
}

/** The MoodleSession value of a signed-in user, or null (signed out, or Moodle unreachable). */
async function readSignedInSession() {
  if (!(await readSessionCookie())) return null;
  try {
    const res = await postJson(PROBE_URL, PROBE_BODY, 'include');
    if (!isSignedInAnswer(await res.json())) return null;
  } catch {
    return null;
  }
  return readSessionCookie();
}

/** Optional extra for when Moodle's app service is on: `{ launch, passport }`, or `{}` when the page gives no link. */
async function captureLaunch() {
  const passport = randomPassport();
  try {
    const res = await fetch(buildLaunchUrl(passport), {
      credentials: 'include',
      cache: 'no-store',
      signal: AbortSignal.timeout(LAUNCH_TIMEOUT_MS),
    });
    const launch = res.ok ? extractLaunchHref(await res.text()) : null;
    return launch ? { launch, passport } : {};
  } catch {
    return {};
  }
}

/** Exchanges the session for a short-lived single-use code: `{ code }`, or `{ error }` (a sync result). */
async function createHandoff(serviceUrl, session) {
  const extra = await captureLaunch();
  try {
    const res = await postJson(`${serviceUrl}/api/connect/handoff`, { session, via: 'extension', ...extra });
    if (res.status === 429) return { error: 'rate_limited' };
    const body = res.ok ? await res.json().catch(() => null) : null;
    return typeof body?.code === 'string' && body.code ? { code: body.code } : { error: 'server_error' };
  } catch {
    return { error: 'network_error' };
  }
}

async function getPendingSignIn() {
  const { pendingSignIn } = await chrome.storage.session.get('pendingSignIn');
  return pendingSignIn && Date.now() < pendingSignIn.until ? pendingSignIn : null;
}

const clearPendingSignIn = () => chrome.storage.session.remove('pendingSignIn');

/**
 * Shows the Moodle sign-in tab (reusing the one already waiting) and records that Connect continues from it. The record
 * is stored, not awaited in memory: the browser may stop the service worker while the user signs in.
 */
async function awaitSignIn() {
  const pending = await getPendingSignIn();
  const open = pending && (await chrome.tabs.update(pending.tabId, { active: true }).catch(() => null));
  const tab = open || (await chrome.tabs.create({ url: LOGIN_URL, active: true }));
  await chrome.storage.session.set({ pendingSignIn: { tabId: tab.id, until: Date.now() + SIGNIN_TIMEOUT_MS } });
  await setResult('signin_required');
}

async function openInTab(url, tabId) {
  if (tabId == null) return chrome.tabs.create({ url });
  return chrome.tabs.update(tabId, { url, active: true }).catch(() => chrome.tabs.create({ url }));
}

/** Hands the signed-in session to the service and opens the console. Null while the user is not signed in. */
const attemptConnect = singleFlight(async () => {
  const serviceUrl = await getConsentedServiceUrl();
  const session = serviceUrl ? await readSignedInSession() : null;
  if (!session) return null;
  const pending = await getPendingSignIn();
  await clearPendingSignIn();
  const { code, error } = await createHandoff(serviceUrl, session);
  if (error) {
    await setResult(error);
    return { ok: false, error };
  }
  await openInTab(buildConnectUrl(serviceUrl, code), pending?.tabId);
  await setResult('connect_opened');
  return { ok: true };
});

/** Sends the current session to the service, which updates an already connected account only. */
const refresh = singleFlight(async () => {
  const serviceUrl = await getConsentedServiceUrl();
  if (!serviceUrl) {
    await updateBadge();
    return { result: 'consent_required' };
  }
  if (!(await hasServicePermission(serviceUrl))) return setResult('permission_missing');
  const session = await readSignedInSession();
  if (!session) return setResult('signin_required');
  try {
    const res = await postJson(`${serviceUrl}/api/extension/refresh`, { session });
    return setResult(refreshResult(res.status, await res.json().catch(() => null)));
  } catch {
    return setResult('network_error');
  }
});

/** The browser got a new Moodle session: finish a waiting Connect, otherwise update the connected account. */
const sessionSync = debounce(async () => {
  if (await getPendingSignIn()) await attemptConnect.runFresh();
  else await refresh.runFresh();
}, SESSION_SETTLE_MS);

async function connect() {
  if (!(await getConsentedServiceUrl())) {
    await chrome.runtime.openOptionsPage();
    return { ok: false, error: 'consent_required' };
  }
  // Connect handles the current session itself; a scheduled sync would race it.
  sessionSync.cancel();
  const done = await attemptConnect.run();
  if (done) return done;
  await awaitSignIn();
  return { ok: false, error: 'signin_required' };
}

const isNewSession = createSessionWatcher();
chrome.cookies.onChanged.addListener((change) => {
  if (isNewSession(change)) sessionSync.schedule();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await getPendingSignIn())?.tabId === tabId) await clearPendingSignIn();
});

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
  if (a.name === ALARM) refresh.run();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.serviceUrl || changes.consent)) updateBadge();
});

async function moodleStatus() {
  // Like every other use of the cookie, the check waits for consent.
  if (!(await getConsentedServiceUrl())) return { signedIn: null };
  return { signedIn: Boolean(await readSignedInSession()) };
}

const HANDLERS = { 'wmm:connect': connect, 'wmm:refresh': refresh.run, 'wmm:moodle-status': moodleStatus };

// There are no content scripts, so only the extension's own pages (popup, settings) can send these messages.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = sender.id === chrome.runtime.id ? HANDLERS[msg?.type] : undefined;
  if (!handler) return false;
  handler().then(sendResponse, () => sendResponse({ ok: false, error: 'internal' }));
  return true;
});
