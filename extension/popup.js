import { applyI18n, t } from './i18n.js';

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

async function render() {
  const { serviceUrl, lastSync } = await chrome.storage.local.get(['serviceUrl', 'lastSync']);
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
}

async function checkMoodle() {
  const res = await chrome.runtime.sendMessage({ type: 'wmm:moodle-status' }).catch(() => null);
  const el = $('moodle');
  el.textContent = t(res?.signedIn ? 'statusSignedIn' : 'statusSignedOut');
  el.className = res?.signedIn ? 'ok' : 'warn';
}

function connectMessageKey(res) {
  if (res?.ok) return null;
  return res?.error === 'signin_required' ? 'resultSigninRequired' : 'resultServerError';
}

$('connect').addEventListener('click', async () => {
  const { serviceUrl } = await chrome.storage.local.get('serviceUrl');
  if (!serviceUrl) {
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
