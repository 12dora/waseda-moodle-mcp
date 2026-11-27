import { applyI18n, t } from './i18n.js';
import { hasConsentFor, makeConsent, privacyUrl } from './lib/consent.js';
import { DEFAULT_SERVICE_URL } from './lib/defaults.js';
import { normalizeServiceUrl } from './lib/moodle.js';

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

// The URL the consent box state belongs to: typing keeps the box as is until the URL itself changes.
let boxOrigin;

/**
 * Reflects the typed URL: privacy link for a valid URL; a new URL resets the box to its stored consent. Before the
 * first save the box starts ticked (the label and the privacy text say what connecting sends; Save is the action).
 */
function syncForm() {
  const origin = normalizeServiceUrl(input.value);
  privacyLink.hidden = !origin;
  if (origin) privacyLink.href = privacyUrl(origin);
  if (origin !== boxOrigin) {
    consentBox.checked = !stored.serviceUrl || hasConsentFor(stored.consent, origin);
    boxOrigin = origin;
  }
  syncBtn.disabled = !hasConsentFor(stored.consent, stored.serviceUrl);
}

input.value = stored.serviceUrl || DEFAULT_SERVICE_URL;
syncForm();
input.addEventListener('input', syncForm);
consentBox.addEventListener('change', () => {
  boxOrigin = normalizeServiceUrl(input.value);
});

async function clearAll() {
  if (stored.serviceUrl) await chrome.permissions.remove({ origins: [`${stored.serviceUrl}/*`] }).catch(() => {});
  await chrome.storage.local.remove(['serviceUrl', 'consent', 'lastSync']);
  stored = {};
  boxOrigin = undefined;
  syncForm();
  say('optionsCleared');
}

async function withdrawConsent() {
  await chrome.storage.local.remove('consent');
  stored = { ...stored, consent: undefined };
  boxOrigin = undefined;
  syncForm();
  say('errorConsentRequired', 'warn');
}

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = input.value.trim();
  if (!raw) return clearAll();
  const origin = normalizeServiceUrl(raw);
  if (!origin) return say('errorHttpsRequired', 'warn');
  if (!consentBox.checked) {
    // Unticking the saved URL withdraws its consent; an unticked new URL is refused and the saved one is kept.
    if (origin === stored.serviceUrl && stored.consent) return withdrawConsent();
    return say('errorConsentRequired', 'warn');
  }
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
