/**
 * Where to go after connecting. Only same-origin paths are accepted. The value is also kept in localStorage for
 * 15 minutes because the bookmarklet and extension flows come back to /connect?code=… without it.
 */

const KEY = 'wmm.return';
const TTL_MS = 15 * 60 * 1000;

function hasUnsafeChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x20 || c === 0x5c || c === 0x7f) return true;
  }
  return false;
}

/** Same-origin path + search + hash, or null. Rejects /connect* and raw control/space/backslash characters. */
export function safeReturn(value: string | null | undefined, origin: string = location.origin): string | null {
  if (!value?.startsWith('/') || hasUnsafeChars(value)) return null;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.pathname.startsWith('/connect')) return null;
  return url.pathname + url.search + url.hash;
}

export function rememberReturn(value: string | null): void {
  const v = safeReturn(value);
  if (!v) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ v, at: Date.now() }));
  } catch {
    // storage unavailable: the query parameter still works for the paste flow
  }
}

function readStored(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: unknown; at?: unknown };
    const fresh = typeof parsed.at === 'number' && Date.now() - parsed.at < TTL_MS;
    return fresh && typeof parsed.v === 'string' ? parsed.v : null;
  } catch {
    return null;
  }
}

/** Consumes the stored return path; the query value wins when valid. */
export function takeReturn(fromQuery: string | null): string {
  const stored = readStored();
  return safeReturn(fromQuery) ?? safeReturn(stored) ?? '/';
}

const UNSAFE_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:']);

/** OAuth redirect targets come from the server; still refuse script-capable schemes. */
export function isSafeRedirect(value: string, origin: string = location.origin): boolean {
  try {
    return !UNSAFE_SCHEMES.has(new URL(value, origin).protocol);
  } catch {
    return false;
  }
}
