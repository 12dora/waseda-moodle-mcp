import { applyI18n, t } from './i18n.js';
import { hasConsentFor } from './lib/consent.js';

applyI18n();
const $ = (id) => document.getElementById(id);
const RESULT_KEYS = {
  updated: 'resultUpdated',
  unchanged: 'resultUnchanged',
  connect_opened: 'resultConnectOpened',
  signin_required: 'resultSigninRequired',
  unknown_user: 'resultUnknownUser',
  rate_limited: 'resultRateLimited',
  server_error: 'resultServerError',
  network_error: 'resultNetworkError',
  permission_missing: 'resultPermissionMissing',
};
const BAD = new Set([
  'signin_required',
  'unknown_user',
  'server_error',
  'network_error',
  'permission_missing',
  'rate_limited',
]);

function showMessage(key) {
  const el = $('message');
  el.hidden = !key;
  if (key) el.textContent = t(key);
}

/** Service URL the user agreed to send the token to, or null (then Connect goes to Settings). */
async function consentedServiceUrl() {
  const { serviceUrl, consent } = await chrome.storage.local.get(['serviceUrl', 'consent']);
  return hasConsentFor(consent, serviceUrl) ? serviceUrl : null;
}

async function render() {
  const { serviceUrl, consent, lastSync } = await chrome.storage.local.get(['serviceUrl', 'consent', 'lastSync']);
  $('service').textContent = serviceUrl || t('statusNotConfigured');
  $('service').className = serviceUrl ? '' : 'warn';
  $('console').disabled = !serviceUrl;
  if (lastSync) {
    const when = new Date(lastSync.at).toLocaleString(chrome.i18n.getUILanguage());
    $('sync').textContent = `${t(RESULT_KEYS[lastSync.result] || 'resultServerError')} · ${when}`;
    $('sync').className = BAD.has(lastSync.result) ? 'warn' : '';
  } else {
    $('sync').textContent = t('statusNever');
    $('sync').className = 'muted';
  }
  if (!serviceUrl) showMessage('hintConfigure');
  else if (!hasConsentFor(consent, serviceUrl)) showMessage('hintConsent');
}

async function checkMoodle() {
  const res = await chrome.runtime.sendMessage({ type: 'wmm:moodle-status' }).catch(() => null);
  const el = $('moodle');
  if (res?.signedIn == null) {
    // Not checked: no consent yet (or the worker did not answer).
    el.textContent = '—';
    el.className = 'muted';
    return;
  }
  el.textContent = t(res.signedIn ? 'statusSignedIn' : 'statusSignedOut');
  el.className = res.signedIn ? 'ok' : 'warn';
}

function connectMessageKey(res) {
  if (res?.ok) return null;
  if (res?.error === 'consent_required') return 'hintConsent';
  return res?.error === 'signin_required' ? 'resultSigninRequired' : 'resultServerError';
}

$('connect').addEventListener('click', async () => {
  if (!(await consentedServiceUrl())) {
    chrome.runtime.openOptionsPage();
    return;
  }
  $('connect').disabled = true;
  showMessage('statusConnecting');
  // The popup may close when a tab opens; the background worker finishes the flow on its own.
  const res = await chrome.runtime.sendMessage({ type: 'wmm:connect' }).catch(() => null);
  $('connect').disabled = false;
  showMessage(connectMessageKey(res));
  render();
});

$('console').addEventListener('click', async () => {
  const { serviceUrl } = await chrome.storage.local.get('serviceUrl');
  if (serviceUrl) chrome.tabs.create({ url: `${serviceUrl}/` });
  window.close();
});

$('settings').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

render();
checkMoodle();
