import { applyI18n, t } from './i18n.js';
import { normalizeServiceUrl } from './lib/capture.js';
import { hasConsentFor, makeConsent, privacyUrl } from './lib/consent.js';

applyI18n();
const input = document.getElementById('serviceUrl');
const consentBox = document.getElementById('consent');
const privacyLink = document.getElementById('privacyLink');
const status = document.getElementById('status');
const syncBtn = document.getElementById('sync');

const SYNC_ERROR_KEYS = {
  signin_required: 'resultSigninRequired',
  unknown_user: 'resultUnknownUser',
  consent_required: 'errorConsentRequired',
};

function say(key, cls = '') {
  status.textContent = key ? t(key) : '';
  status.className = cls;
}

let stored = await chrome.storage.local.get(['serviceUrl', 'consent']);

/** Reflects the typed URL: privacy link for a valid URL; the box stays ticked only if consent exists for that URL. */
function syncForm() {
  const origin = normalizeServiceUrl(input.value);
  privacyLink.hidden = !origin;
  if (origin) privacyLink.href = privacyUrl(origin);
  consentBox.checked = hasConsentFor(stored.consent, origin);
  syncBtn.disabled = !hasConsentFor(stored.consent, stored.serviceUrl);
}

input.value = stored.serviceUrl || '';
syncForm();
input.addEventListener('input', syncForm);

async function clearAll() {
  await chrome.storage.local.remove(['serviceUrl', 'consent', 'lastSync']);
  stored = {};
  syncForm();
  say('optionsCleared');
}

async function withdrawConsent() {
  await chrome.storage.local.remove('consent');
  stored = { ...stored, consent: undefined };
  syncForm();
  say('errorConsentRequired', 'warn');
}

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = input.value.trim();
  if (!raw) return clearAll();
  const origin = normalizeServiceUrl(raw);
  if (!origin) return say('errorHttpsRequired', 'warn');
  if (!consentBox.checked) return withdrawConsent();
  // Must run directly in the click handler's user gesture.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
  if (!granted) return say('errorPermissionDenied', 'warn');
  const prev = stored.serviceUrl;
  if (prev && prev !== origin) {
    await chrome.permissions.remove({ origins: [`${prev}/*`] }).catch(() => {});
    await chrome.storage.local.remove('lastSync');
  }
  stored = { serviceUrl: origin, consent: makeConsent(origin) };
  await chrome.storage.local.set(stored);
  input.value = origin;
  syncForm();
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
