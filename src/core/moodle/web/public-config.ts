/**
 * The site flag behind the channel choice: whether Moodle's mobile web service (the token channel) is on, from the
 * public, login-free tool_mobile_get_public_config.
 */

import { MOODLE_URL } from '../launch';
import { isObj } from '../wire';

const TIMEOUT_MS = 15_000;

/** true / false = what the site says; null = Moodle could not be asked (network, 5xx, odd answer). One request. */
export async function mobileServiceEnabled(doFetch: typeof fetch, baseUrl = MOODLE_URL): Promise<boolean | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(`${baseUrl}/lib/ajax/service-nologin.php?info=tool_mobile_get_public_config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify([{ index: 0, methodname: 'tool_mobile_get_public_config', args: {} }]),
      redirect: 'manual',
      signal: ac.signal,
    });
    if (res.status !== 200) {
      res.body?.cancel().catch(() => {});
      return null;
    }
    const parsed: unknown = JSON.parse(await res.text());
    const entry: unknown = Array.isArray(parsed) ? parsed[0] : null;
    if (!isObj(entry) || entry.error === true || !isObj(entry.data)) return null;
    return Number(entry.data.enablemobilewebservice) === 1;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
