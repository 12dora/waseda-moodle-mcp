// Pure helpers shared by the background worker and tests. No chrome.* access here.

export const MOODLE_ORIGIN = 'https://wsdmoodle.waseda.jp';
export const LOGIN_URL = `${MOODLE_ORIGIN}/login/index.php`;

export function randomPassport(bytes = 8) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function buildLaunchUrl(passport) {
  if (!passport || !/^[A-Za-z0-9_-]+$/.test(passport)) throw new Error('invalid passport');
  const q = new URLSearchParams({
    service: 'moodle_mobile_app',
    passport,
    urlscheme: 'moodlemobile',
    confirmed: '1',
  });
  return `${MOODLE_ORIGIN}/admin/tool/mobile/launch.php?${q}`;
}

const LAUNCH_RE =
  /<a\b[^>]*\bid=["']launchapp["'][^>]*\bhref=["']([^"']+)["']|<a\b[^>]*\bhref=["']([^"']+)["'][^>]*\bid=["']launchapp["']/i;

/** Returns the decoded launch href (`<scheme>://token=…`) or null. */
export function extractLaunchHref(html) {
  if (typeof html !== 'string') return null;
  const m = html.match(LAUNCH_RE);
  const raw = m && (m[1] || m[2]);
  if (!raw) return null;
  const href = raw.replace(/&amp;/g, '&');
  return /^[a-z][a-z0-9+.-]*:\/\/token=/i.test(href) ? href : null;
}

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

/** Handoff codes are opaque; the token itself never goes into a URL. */
export function buildConnectUrl(service, code) {
  return `${service}/connect?code=${encodeURIComponent(code)}`;
}
