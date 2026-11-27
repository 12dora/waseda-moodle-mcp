/** The paste field of the connect page: a MoodleSession cookie, or a Moodle app launch link. */

import { ApiError } from '../api/client';
import type { ConnectRequest } from '../api/types';
import type { MessageKey } from '../i18n/core';

/** `<scheme>://…` (also URL-encoded) or `token=…`, possibly inside the quotes or brackets that copying adds. */
const LAUNCH_PREFIX = /^["'`<([\s]*(?:[a-z][a-z0-9+.-]*(?::\/\/|%3a%2f%2f)|token=)/i;

/** The passport of the instance's launch page: the server checks a launch link's signature against it. */
function passportOf(launchUrl: string): string | undefined {
  try {
    return new URL(launchUrl).searchParams.get('passport') ?? undefined;
  } catch {
    return undefined;
  }
}

type PasteRequest = Extract<ConnectRequest, { via: 'paste' }>;

/**
 * POST /api/connect body for the pasted text: a launch link by its prefix, anything else is the session cookie (the
 * bare value or `MoodleSession=…`; the server normalises it). Null when nothing was pasted.
 */
export function pasteRequest(input: string, launchUrl: string): PasteRequest | null {
  const value = input.trim();
  if (!value) return null;
  if (LAUNCH_PREFIX.test(value)) return { launch: value, via: 'paste', passport: passportOf(launchUrl) };
  return { session: value, via: 'paste' };
}

/** Error codes that mean Moodle (or the server) refused the pasted text itself. */
const REFUSED = new Set(['invalid_input', 'needs_reconnect']);

/** Message for refused paste input; null for any other failure (it keeps its usual text). */
export function pasteErrorKey(e: unknown, request: PasteRequest): MessageKey | null {
  if (!(e instanceof ApiError) || !REFUSED.has(e.code)) return null;
  return 'session' in request ? 'connect.paste.badSession' : 'connect.paste.badLaunch';
}
