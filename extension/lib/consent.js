// Affirmative consent for sending the Moodle sign-in session, bound to one service URL. Pure; no chrome.* access.

// What the user agreed to send. A record for anything else (1.0 asked about the app token) does not count.
const SCOPE = 'session';

/** Consent record stored in chrome.storage.local under `consent`. */
export function makeConsent(serviceUrl, now = Date.now()) {
  return { serviceUrl, scope: SCOPE, at: now };
}

/** True only when consent to send the session was given for exactly this (normalised) service URL. */
export function hasConsentFor(consent, serviceUrl) {
  return Boolean(serviceUrl && consent?.serviceUrl === serviceUrl && consent.scope === SCOPE);
}

export function privacyUrl(serviceUrl) {
  return `${serviceUrl}/privacy`;
}
