import { describe, expect, it } from 'vitest';
import {
  BudgetExceeded,
  Forbidden,
  InvalidInput,
  MailNeedsReconnect,
  MoodleError,
  MoodleUnavailable,
  NeedsReconnect,
  NotFound,
  RateLimited,
  withOwnStep,
} from '../../src/core/errors';
import { explainError, type HintTarget } from '../../src/core/mcp/error-hints';
import { RECONNECT_STDIO } from '../../src/core/mcp/wording';

const ORIGIN = 'https://wasemoodle.example.com';
const worker = (tool?: string): HintTarget => ({ mode: 'worker', publicUrl: ORIGIN, tool });
const ACTIVITY = 'https://wsdmoodle.waseda.jp/mod/assign/view.php?id=7001';
const say = (e: Parameters<typeof explainError>[0], tool?: string) => explainError(e, worker(tool));
const MAINTENANCE = 'Waseda Moodle is under maintenance. Try again after the maintenance ends.';

describe('explainError', () => {
  it('reconnect: sign in to Moodle (the extension renews), else /connect with the cookie', () => {
    const text = say(new NeedsReconnect(), 'get_course');
    expect(text).toMatch(/^The Moodle connection has ended\. /);
    expect(text).toContain('sign in to Waseda Moodle');
    expect(text).toContain('browser extension');
    expect(text).toContain(`${ORIGIN}/connect`);
    expect(text).toContain('MoodleSession cookie');
    const mail = say(new MailNeedsReconnect('Expired.'));
    expect(mail).toBe(`Expired. Ask the user to reconnect mail at ${ORIGIN}/settings/mail, then try again.`);
  });

  it('reconnect on stdio: the connect command', () => {
    expect(explainError(new NeedsReconnect(), { mode: 'stdio', publicUrl: '' })).toBe(RECONNECT_STDIO);
    expect(RECONNECT_STDIO).toContain('waseda-moodle-mcp connect');
  });

  it('no permission: hidden by the teacher or not enrolled, with the page to check', () => {
    const page = new MoodleError('Moodle refused access to this page.', 'nopermissions', '', { url: ACTIVITY });
    const text = say(page, 'get_activity');
    expect(text).toMatch(/^Moodle refused access to this page\. The teacher may have hidden it/);
    expect(text).toContain('not enrolled');
    expect(text).toContain(`Check it on Moodle: ${ACTIVITY}`);
    const ajax = say(new MoodleError('このコースに登録されていません。', 'requireloginerror'));
    expect(ajax).toMatch(/^Moodle refused access to this\. /);
    expect(ajax).not.toMatch(/[\u3000-\u9fff]/);
    expect(ajax).toContain('https://wsdmoodle.waseda.jp/');
  });

  it('not found: deleted or a wrong id, with the tool that lists ids again', () => {
    const course = say(new NotFound('Course 99101 is not one of your enrolled courses.'), 'get_course');
    expect(course).toContain('enrolled courses. It may have been deleted, or the id is wrong: call list_courses again');
    expect(say(new MoodleError('x', 'invalidrecord'), 'get_discussion')).toContain('call list_discussions again');
    expect(say(new NotFound('Post 1 was not found.'), 'prepare_forum_post')).toContain('call get_discussion again');
    expect(say(new NotFound('x'), 'resource:course')).toContain('call list_courses again');
    expect(say(new NotFound('Action not found.'), 'confirm_action')).toContain('prepare the action again');
    expect(say(new NotFound('x'))).toContain('look it up again');
  });

  it('web session only: do it on Moodle directly', () => {
    const text = say(new MoodleError('Not available through the Moodle web session.', 'servicenotavailable'));
    expect(text).toContain('session. Ask the user to do this on Moodle directly: https://wsdmoodle.waseda.jp/');
  });

  it('unreachable vs maintenance', () => {
    expect(say(new MoodleUnavailable())).toContain('try again in a few minutes');
    const m = new MoodleUnavailable('Waseda Moodle is under maintenance.', { maintenance: true, until: '06:00' });
    expect(say(m)).toBe(MAINTENANCE);
    expect(say(new MoodleError('サイトはメンテナンス中です。', 'sitemaintenance'))).toBe(MAINTENANCE);
  });

  it('budget: narrow the request (Moodle) or the search (mail)', () => {
    expect(say(new BudgetExceeded(), 'get_due_items')).toContain('pass course_id');
    const mail = say(new BudgetExceeded('Too many mail requests.'), 'search_mail');
    expect(mail).toBe('Too many mail requests. Narrow the search and try again.');
  });

  it('rate limited: the wait when known', () => {
    expect(say(new RateLimited(undefined, 30))).toBe('Too many requests. Wait 30 seconds and try again.');
    expect(say(new RateLimited(undefined, 600))).toContain('Wait 10 minutes');
    expect(say(new RateLimited())).toContain('Wait a minute');
  });

  it("write outcomes: Moodle's validation text is kept; uploads say what to change", () => {
    const invalid = say(new MoodleError('件名は必須です。', 'validation'), 'confirm_action');
    expect(invalid).toBe('件名は必須です。 Correct it and prepare the action again.');
    expect(say(new MoodleError('Too large.', 'fileoversized'))).toContain('smaller file');
    expect(say(new MoodleError('Already in the draft.', 'fileexists'))).toContain('Rename the file');
  });

  it('leaves errors alone that name their own step, have none, or already carry it', () => {
    const own = withOwnStep(new NotFound('Upload not found. Create a new one with create_upload_link.'));
    expect(say(own, 'prepare_submission')).toBe(own.message);
    expect(say(new InvalidInput('subscribe must be true or false.'))).toBe('subscribe must be true or false.');
    expect(say(new Forbidden('This connection is read-only.'))).toBe('This connection is read-only.');
    const once = say(new BudgetExceeded());
    expect(say(new BudgetExceeded(once))).toBe(once);
    const named = new NeedsReconnect(`Reconnect at ${ORIGIN}/connect.`);
    expect(say(named)).toBe(named.message);
  });
});
