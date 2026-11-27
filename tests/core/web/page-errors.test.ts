import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { MoodleError, MoodleUnavailable } from '../../../src/core/errors';
import { maintenanceEnd, maintenanceError, pageError } from '../../../src/core/moodle/web/page-errors';
import { MoodleWebSession } from '../../../src/core/moodle/web/session';

const BASE = 'https://wsdmoodle.waseda.jp';
const fixture = (name: string) => readFileSync(new URL(`../../fixtures/web/${name}`, import.meta.url), 'utf8');
/** Invented notice text; the markup follows Moodle's print_maintenance_message() (no Waseda sample yet). */
const MAINTENANCE = fixture('core-maintenance-ja.html');

function session(answer: () => Response) {
  return new MoodleWebSession({
    cookie: 'MoodleSession=abcdefghij0123456789xyz',
    sesskey: 'Key0000001',
    moodleUserId: 7001,
    baseUrl: BASE,
    fetch: vi.fn(async () => answer()) as unknown as typeof fetch,
    charge: () => undefined,
  });
}

describe('maintenanceEnd', () => {
  it('takes the last time of the notice with the last date before it', () => {
    expect(maintenanceEnd('2026年11月30日（月）0:00～6:00 の間、ご利用いただけません。')).toBe('11/30 06:00');
    expect(maintenanceEnd('Moodle is unavailable from 11/30 2:00 until 11/30 7:30.')).toBe('11/30 07:30');
    expect(maintenanceEnd('Back at 18:45')).toBe('18:45');
    expect(maintenanceEnd('Back soon.')).toBeNull();
  });
});

describe('maintenanceError', () => {
  it("reads Moodle's maintenance page and the end its notice gives", () => {
    const e = maintenanceError(MAINTENANCE);
    expect(e).toBeInstanceOf(MoodleUnavailable);
    expect(e?.maintenance).toBe(true);
    expect(e?.until).toBe('11/30 06:00');
    expect(e?.message).toBe('Waseda Moodle is under maintenance (its notice gives 11/30 06:00 JST as the end).');
  });

  it('knows the static CLI maintenance page and ignores other pages', () => {
    const cli = maintenanceError('<html><body><h1>Example is under maintenance</h1></body></html>');
    expect(cli).toMatchObject({ maintenance: true, until: null, message: 'Waseda Moodle is under maintenance.' });
    expect(maintenanceError('<html><body>Bad gateway</body></html>')).toBeNull();
  });
});

describe('pageError', () => {
  it('gives known codes an English message and keeps the page address', () => {
    const e = pageError(fixture('core-error-record-en.html'), `${BASE}/mod/assign/view.php?id=7001`);
    expect(e).toBeInstanceOf(MoodleError);
    expect(e).toMatchObject({ errorcode: 'invalidrecord', message: 'Moodle could not find this item.' });
    expect(e?.url).toBe(`${BASE}/mod/assign/view.php?id=7001`);
  });
});

describe('MoodleWebSession and maintenance', () => {
  it('turns a 503 maintenance page into MoodleUnavailable(maintenance)', async () => {
    const s = session(() => new Response(MAINTENANCE, { status: 503 }));
    const e = await s.page('/my/').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MoodleUnavailable);
    expect(e).toMatchObject({ maintenance: true, until: '11/30 06:00' });
  });

  it('keeps other 5xx answers plain', async () => {
    const catchAll = (x: unknown) => x;
    const e = await session(() => new Response('busy', { status: 503 }))
      .page('/my/')
      .catch(catchAll);
    expect(e).toMatchObject({ maintenance: false });
    const bad = await session(() => new Response(MAINTENANCE, { status: 502 }))
      .page('/my/')
      .catch(catchAll);
    expect(bad).toMatchObject({ maintenance: false });
  });

  it('maps a request-level ajax errorcode sitemaintenance', async () => {
    const answer = { error: 'メンテナンス中', errorcode: 'sitemaintenance' };
    const e = await session(() => Response.json(answer))
      .ajax('core_session_touch')
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ maintenance: true });
  });

  it('drops the sesskey from the page address of an error', async () => {
    const s = session(() => new Response('<html></html>', { status: 403 }));
    const e = await s.page('/mod/forum/post.php?delete=7001&sesskey=Key0000001').catch((x: unknown) => x);
    expect(e).toMatchObject({ errorcode: 'nopermissions', url: `${BASE}/mod/forum/post.php?delete=7001` });
  });
});
