/**
 * core_webservice_get_site_info on the web channel, for the fields this codebase reads (siteurl, userid, fullname,
 * username, lang): the user's profile page. `username` is not shown to students: ''. `lang` is the session's
 * interface language (omitted when the page does not say).
 */

import { MoodleError } from '../../../errors';
import { parseIdentity } from '../identify';
import type { WebFunctions, WebSession } from '../types';

async function siteInfo(web: WebSession) {
  const who = parseIdentity((await web.page('/user/profile.php')).html);
  if (!who) throw new MoodleError('Moodle did not show the profile page.', 'moodle_error');
  return {
    siteurl: web.baseUrl,
    userid: who.moodleUserId,
    fullname: who.fullname,
    username: '',
    ...(who.lang ? { lang: who.lang } : {}),
  };
}

export const identityFunctions: WebFunctions = {
  core_webservice_get_site_info: (web) => siteInfo(web),
};
