// Moodle addresses and URL helpers shared by the extension pages, the background worker and tests. No chrome.* access.

export const MOODLE_ORIGIN = 'https://wsdmoodle.waseda.jp';
export const LOGIN_URL = `${MOODLE_ORIGIN}/login/index.php`;

/** Normalises a user-entered service URL to its origin; null if not https. */
export function normalizeServiceUrl(input) {
  try {
    const u = new URL(String(input).trim());
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Handoff codes are opaque; the session itself never goes into a URL. */
export function buildConnectUrl(service, code) {
  return `${service}/connect?code=${encodeURIComponent(code)}`;
}
