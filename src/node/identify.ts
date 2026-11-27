/** Who an app token belongs to (the web session counterpart is identifySession in core/moodle/web). */

import { InvalidInput, MoodleError } from '../core/errors';
import { MoodleClient } from '../core/moodle/client';
import { MOODLE_URL } from '../core/moodle/launch';

export interface Identity {
  moodleUserId: number;
  fullname: string;
  lang: string;
}

const APP_SERVICE_OFF =
  'Waseda Moodle has turned off the app service, so an app token no longer works. Run "waseda-moodle-mcp connect" ' +
  'with the MoodleSession cookie (see --help); unset WMM_TOKEN if you set it.';
/** Error codes of a site whose app service is off (an expired token is NeedsReconnect instead). */
const OFF_CODES = new Set(['accessexception', 'servicenotavailable']);

interface SiteInfo {
  siteurl?: unknown;
  userid?: unknown;
  fullname?: unknown;
  lang?: unknown;
}

function isWasedaSite(siteurl: unknown): boolean {
  if (typeof siteurl !== 'string') return false;
  try {
    return new URL(siteurl).origin === new URL(MOODLE_URL).origin;
  } catch {
    return false;
  }
}

async function siteInfo(token: string, doFetch: typeof fetch): Promise<SiteInfo> {
  const client = new MoodleClient({ token, moodleUserId: 0, fetch: doFetch });
  try {
    return await client.call<SiteInfo>('core_webservice_get_site_info');
  } catch (e) {
    if (e instanceof MoodleError && OFF_CODES.has(e.errorcode)) throw new InvalidInput(APP_SERVICE_OFF);
    throw e;
  }
}

/** core_webservice_get_site_info: proves the token works and tells us whose it is. */
export async function identifyToken(token: string, doFetch: typeof fetch): Promise<Identity> {
  const { siteurl, userid, fullname, lang } = await siteInfo(token, doFetch);
  if (!isWasedaSite(siteurl) || typeof userid !== 'number' || userid <= 0) {
    throw new InvalidInput('That token does not belong to Waseda Moodle.');
  }
  return {
    moodleUserId: userid,
    fullname: typeof fullname === 'string' && fullname ? fullname : `User ${userid}`,
    lang: typeof lang === 'string' && lang ? lang : 'en',
  };
}
