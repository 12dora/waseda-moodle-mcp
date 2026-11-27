import { describe, expect, it } from 'vitest';
import { parseMoodleDate } from '../../../src/core/moodle/web/dates';
import {
  findAll,
  findFirst,
  findForm,
  formFields,
  mainRegion,
  pageConfig,
  queryInt,
  text,
} from '../../../src/core/moodle/web/html';

const PAGE = `<!DOCTYPE html><html dir="ltr" lang="ja" xml:lang="ja"><head><script>
M.cfg = {"wwwroot":"https:\\/\\/example.test","sesskey":"Abc123xyz","courseId":99101,"courseContextId":501,"contextid":502,"contextInstanceId":7001,"userId":4242};
</script></head><body><div id="page"><div id="region-main">
<div data-region="activity-dates" class="activity-dates"><div><strong>開始:</strong> 2026年 10月 2日(金曜日) 13:10</div>
<div><strong>期限:</strong> 2026年 10月 8日(木曜日) 23:59</div></div>
<ul><li class="activity assign" data-for="cmitem" data-id="7001"><div><div>A</div></div></li>
<li class="activity quiz" data-for="cmitem" data-id="7002"><br><img src="x.png"></li></ul>
<form action="https://example.test/mod/assign/view.php" method="post"><input type="hidden" name="id" value="7001">
<input type="hidden" name="sesskey" value="Abc123xyz"><input type="checkbox" name="statement" value="1" checked>
<input type="checkbox" name="other" value="1"><textarea name="onlinetext_editor[text]">&lt;p&gt;hi&lt;/p&gt;</textarea>
<select name="fmt"><option value="0">a</option><option value="1" selected>b</option></select>
<input type="submit" name="submitbutton" value="Save"></form>
<a href="https://example.test/mod/forum/view.php?f=55&amp;page=2">x</a>
</div></div></body></html>`;

describe('web html helpers', () => {
  it('reads M.cfg and the page language', () => {
    expect(pageConfig(PAGE)).toEqual({
      sesskey: 'Abc123xyz',
      userId: 4242,
      courseId: 99101,
      contextInstanceId: 7001,
      contextId: 502,
      courseContextId: 501,
      lang: 'ja',
    });
  });

  it('finds elements with balanced nesting and class words', () => {
    const items = findAll(mainRegion(PAGE), { attr: 'data-for', value: 'cmitem' });
    expect(items.map((i) => i.inner.includes('<div>A</div>'))).toEqual([true, false]);
    expect(findAll(PAGE, { attr: 'class', value: 'quiz', word: true })[0]?.tag).toBe('li');
    const dates = findFirst(PAGE, { attr: 'data-region', value: 'activity-dates' });
    expect(text(dates?.inner ?? '')).toBe('開始: 2026年 10月 2日(金曜日) 13:10 期限: 2026年 10月 8日(木曜日) 23:59');
  });

  it('collects form fields like a browser would', () => {
    const form = findForm(PAGE, '/mod/assign/view.php');
    const fields = formFields(form?.inner ?? '');
    expect(Object.fromEntries(fields)).toEqual({
      id: '7001',
      sesskey: 'Abc123xyz',
      statement: '1',
      'onlinetext_editor[text]': '<p>hi</p>',
      fmt: '1',
    });
  });

  it('reads numeric query parameters', () => {
    expect(queryInt('https://example.test/mod/forum/view.php?f=55&amp;page=2', 'page')).toBe(2);
    expect(queryInt('/x.php?id=abc', 'id')).toBeNull();
  });
});

describe('parseMoodleDate', () => {
  const at = (iso: string) => Date.parse(iso) / 1000;
  it('reads Japanese and Chinese dates as JST', () => {
    expect(parseMoodleDate('期限: 2026年 10月 8日(木曜日) 23:59')).toBe(at('2026-10-08T23:59:00+09:00'));
    expect(parseMoodleDate('2027年 01月 14日(木曜日), 23:59')).toBe(at('2027-01-14T23:59:00+09:00'));
    expect(parseMoodleDate('2026年10月8日 星期四 09:05')).toBe(at('2026-10-08T09:05:00+09:00'));
    expect(parseMoodleDate('２０２６年１０月８日 ２３：５９')).toBe(at('2026-10-08T23:59:00+09:00'));
  });
  it('reads English dates with AM/PM', () => {
    expect(parseMoodleDate('Due: Thursday, 8 October 2026, 11:59 PM')).toBe(at('2026-10-08T23:59:00+09:00'));
    expect(parseMoodleDate('Opened: Friday, 2 October 2026, 12:10 AM')).toBe(at('2026-10-02T00:10:00+09:00'));
    expect(parseMoodleDate('2 October 2026, 13:10')).toBe(at('2026-10-02T13:10:00+09:00'));
  });
  it('gives null for text without a date', () => {
    expect(parseMoodleDate('明日')).toBeNull();
    expect(parseMoodleDate('8 Foo 2026, 10:00')).toBeNull();
  });
});

describe('quoted attributes', () => {
  it('keeps a `>` inside a quoted attribute value', () => {
    const html =
      '<form action="/x.php"><input type="submit" name="next" value="Next >>"><input name="a" value=\'1>2\'></form>';
    const form = findForm(html, '/x.php');
    expect(findAll(form?.inner ?? '', { attr: 'name', tag: 'input' }).map((i) => i.attrs.includes('>'))).toEqual([
      true,
      true,
    ]);
  });
});

describe('formFields: PHP semantics', () => {
  it('keeps the last control of a name (advcheckbox) and skips disabled controls', () => {
    const form =
      '<input type="hidden" name="pinned" value="0"><input type="checkbox" name="pinned" value="1" checked>' +
      '<input type="hidden" name="mailnow" value="0"><input type="checkbox" name="mailnow" value="1">' +
      '<input type="text" name="x" value="a" disabled>';
    expect(Object.fromEntries(formFields(form))).toEqual({ pinned: '1', mailnow: '0' });
  });
});
