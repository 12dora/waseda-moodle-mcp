import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { identityFunctions } from '../../../../src/core/moodle/web/adapters/identity';
import type { WebSession } from '../../../../src/core/moodle/web/types';
import { makeFakeWebSession } from '../../../helpers/fake-web-session';

const fixture = (name: string) => readFileSync(join(__dirname, '../../../fixtures/web', name), 'utf8');

const siteInfo = (web: WebSession) => {
  const impl = identityFunctions.core_webservice_get_site_info;
  if (!impl) throw new Error('not emulated');
  return impl(web, {}, {});
};

describe('core_webservice_get_site_info', () => {
  it('reads the user from the profile page (ja)', async () => {
    const web = makeFakeWebSession({ pages: { '/user/profile.php': fixture('core-profile-ja.html') } });
    expect(await siteInfo(web)).toEqual({
      siteurl: 'https://wsdmoodle.waseda.jp',
      userid: 7001,
      fullname: '山田 太郎',
      username: '',
      lang: 'ja',
    });
    expect(web.calls).toEqual(['GET /user/profile.php']);
  });

  it('reads the user from the profile page (en)', async () => {
    const web = makeFakeWebSession({ pages: { '/user/profile.php': fixture('core-profile-en.html') } });
    expect(await siteInfo(web)).toMatchObject({ userid: 7002, fullname: 'Taro & Yamada', lang: 'en' });
  });

  it('a page without a user is a Moodle error', async () => {
    const web = makeFakeWebSession({ pages: { '/user/profile.php': '<html><body>nothing</body></html>' } });
    await expect(siteInfo(web)).rejects.toMatchObject({ errorcode: 'moodle_error' });
  });
});
