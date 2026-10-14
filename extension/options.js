import { applyI18n, t } from './i18n.js';
import { normalizeServiceUrl } from './lib/capture.js';

applyI18n();
const input = document.getElementById('serviceUrl');
const status = document.getElementById('status');
const syncBtn = document.getElementById('sync');

const SYNC_ERROR_KEYS = { signin_required: 'resultSigninRequired', unknown_user: 'resultUnknownUser' };

function say(key, cls = '') {
  status.textContent = key ? t(key) : '';
  status.className = cls;
}

const { serviceUrl } = await chrome.storage.local.get('serviceUrl');
input.value = serviceUrl || '';
syncBtn.disabled = !serviceUrl;

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = input.value.trim();
  if (!raw) {
    await chrome.storage.local.remove(['serviceUrl', 'lastSync']);
    syncBtn.disabled = true;
    say('optionsCleared');
    return;
  }
  const origin = normalizeServiceUrl(raw);
  if (!origin) {
    say('errorHttpsRequired', 'warn');
    return;
  }
  // Must run directly in the click handler's user gesture.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
  if (!granted) {
    say('errorPermissionDenied', 'warn');
    return;
  }
  const prev = (await chrome.storage.local.get('serviceUrl')).serviceUrl;
  if (prev && prev !== origin) {
    await chrome.permissions.remove({ origins: [`${prev}/*`] }).catch(() => {});
    await chrome.storage.local.remove('lastSync');
  }
  await chrome.storage.local.set({ serviceUrl: origin });
  input.value = origin;
  syncBtn.disabled = false;
  say('optionsSaved', 'ok');
});

syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true;
  say('statusSyncing');
  const res = await chrome.runtime.sendMessage({ type: 'wmm:refresh' }).catch(() => null);
  syncBtn.disabled = false;
  const ok = res && (res.result === 'updated' || res.result === 'unchanged');
  say(ok ? 'optionsSyncOk' : SYNC_ERROR_KEYS[res?.result] || 'resultServerError', ok ? 'ok' : 'warn');
});
