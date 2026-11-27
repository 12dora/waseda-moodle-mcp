/** The Moodle connection as the console shows it. */

import type { CredentialInfo } from '../api/types';

type Checks = Pick<CredentialInfo, 'lastOkAt' | 'sessionOkAt'>;

/**
 * When Moodle last confirmed the connection: the later of the last successful request and the last answer through the
 * web session (a request or the keepalive). Null when neither happened.
 */
export function lastCheckedAt({ lastOkAt, sessionOkAt }: Checks): string | null {
  if (!lastOkAt || !sessionOkAt) return lastOkAt ?? sessionOkAt;
  return Date.parse(sessionOkAt) > Date.parse(lastOkAt) ? sessionOkAt : lastOkAt;
}
