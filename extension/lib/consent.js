// Affirmative consent for sending the Moodle token, bound to one service URL. Pure; no chrome.* access.

/** Consent record stored in chrome.storage.local under `consent`. */
export function makeConsent(serviceUrl, now = Date.now()) {
  return { serviceUrl, at: now };
}

/** True only when consent was given for exactly this (normalised) service URL. */
export function hasConsentFor(consent, serviceUrl) {
  return Boolean(serviceUrl && consent && typeof consent === 'object' && consent.serviceUrl === serviceUrl);
}

export function privacyUrl(serviceUrl) {
  return `${serviceUrl}/privacy`;
}
