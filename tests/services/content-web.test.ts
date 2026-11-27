import { describe, expect, it } from 'vitest';
import { loadContent } from '../../src/core/services/activity/content';
import { makeWebApi, redirectTo } from './web-channel';

const info = (modname: string) => ({
  courseName: '総合日本語３Ｘ',
  url: `https://wsdmoodle.waseda.jp/mod/${modname}/view.php?id=7501`,
  lang: 'ja',
  courseId: 99101,
  modname,
});
const cm = (modname: string) => ({ cmid: 7501, courseId: 99101, modname, instance: 7501, name: '資料' });
const contents = (modname: string) => [{ modules: [{ id: 7501, name: '資料', modname, description: '<p>説明</p>' }] }];

describe('loadContent on the web channel', () => {
  it('names the cmid in the course contents call and reads a resource file from its activity page', async () => {
    const api = makeWebApi({
      pages: {
        '/mod/resource/view.php?id=7501&redirect=1': () =>
          redirectTo('/pluginfile.php/88001/mod_resource/content/1/handout.pdf'),
      },
      handlers: { core_course_get_contents: contents('resource') },
    });
    const c = await loadContent(api, cm('resource'), info('resource'));
    expect(c.description).toBe('説明');
    expect(c.files.map((f) => f.name)).toEqual(['handout.pdf']);
    expect(api.calls[0]?.hint).toEqual({ cmid: 7501 });
  });

  it('keeps a resource whose page cannot be read, without files', async () => {
    const api = makeWebApi({ handlers: { core_course_get_contents: contents('resource') } });
    const c = await loadContent(api, cm('resource'), info('resource'));
    expect(c.files).toEqual([]);
    expect(c.description).toBe('説明');
  });

  it('says that a book cannot be read on this channel, and passes the hint to page reads', async () => {
    const book = makeWebApi({ handlers: { core_course_get_contents: contents('book') } });
    const b = await loadContent(book, cm('book'), info('book'));
    expect(b.body).toContain('cannot be read through the Moodle web session');
    const page = makeWebApi({
      handlers: {
        mod_page_get_pages_by_courses: { pages: [{ coursemodule: 7501, name: '資料', content: '<p>本文</p>' }] },
      },
    });
    const p = await loadContent(page, cm('page'), info('page'));
    expect(p.body).toBe('本文');
    expect(page.calls[0]).toMatchObject({ fn: 'mod_page_get_pages_by_courses', hint: { cmid: 7501 } });
  });
});
