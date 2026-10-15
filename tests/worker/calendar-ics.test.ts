import { describe, expect, it } from 'vitest';
import { escapeText, foldLine, formatUtc, type IcsEvent, jstToMs, renderCalendar } from '../../src/worker/calendar/ics';

const encoder = new TextEncoder();
const octets = (s: string) => encoder.encode(s).length;
const unfold = (s: string) => s.replace(/\r\n /g, '');

describe('escapeText', () => {
  it('escapes backslash, semicolon, comma and line breaks', () => {
    expect(escapeText('a\\b; c, d\ne\r\nf')).toBe('a\\\\b\\; c\\, d\\ne\\nf');
  });

  it('replaces other control characters with spaces', () => {
    expect(escapeText('a\u0000b\u0007c\td\u007fe')).toBe('a b c d e');
  });

  it('keeps non-ASCII text as it is', () => {
    expect(escapeText('企業価値評価 (月1-2)')).toBe('企業価値評価 (月1-2)');
  });
});

describe('foldLine', () => {
  it('leaves a line of up to 75 octets alone', () => {
    const line = `SUMMARY:${'a'.repeat(67)}`;
    expect(octets(line)).toBe(75);
    expect(foldLine(line)).toBe(line);
  });

  it('folds long ASCII lines at 75 octets with a leading space on continuations', () => {
    const line = `DESCRIPTION:${'x'.repeat(200)}`;
    const parts = foldLine(line).split('\r\n');
    expect(parts.length).toBeGreaterThan(2);
    expect(octets(parts[0] ?? '')).toBe(75);
    for (const part of parts.slice(1)) {
      expect(part.startsWith(' ')).toBe(true);
      expect(octets(part)).toBeLessThanOrEqual(75);
    }
    expect(unfold(foldLine(line))).toBe(line);
  });

  it('never splits a multi-byte character or a surrogate pair', () => {
    const line = `SUMMARY:${'授業'.repeat(40)}${'😀'.repeat(20)}`;
    const folded = foldLine(line);
    for (const part of folded.split('\r\n')) expect(octets(part)).toBeLessThanOrEqual(75);
    expect(unfold(folded)).toBe(line);
    expect(folded).not.toContain('\ufffd');
  });
});

describe('time conversion', () => {
  it('formats UTC without separators or milliseconds', () => {
    expect(formatUtc(Date.UTC(2026, 9, 15, 14, 30, 5, 123))).toBe('20261015T143005Z');
  });

  it('converts JST wall-clock times (UTC+9, no DST) across midnight', () => {
    expect(formatUtc(jstToMs('2026-10-19', '08:50'))).toBe('20261018T235000Z');
    expect(formatUtc(jstToMs('2026-10-19', '21:35'))).toBe('20261019T123500Z');
  });
});

describe('renderCalendar', () => {
  const stamp = Date.UTC(2026, 9, 15, 0, 0, 0);
  const base: IcsEvent = { uid: 'wmm-due-1@example.com', start: Date.UTC(2026, 9, 16, 14, 59), summary: 'Report' };

  it('writes a CRLF-terminated VCALENDAR with PRODID, VERSION and the event fields', () => {
    const ics = renderCalendar({ name: 'Waseda Moodle', stamp, events: [base] });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const lines = ics.split('\r\n');
    expect(lines).toEqual(
      expect.arrayContaining([
        'VERSION:2.0',
        'PRODID:-//wasemoodle//Waseda Moodle MCP//EN',
        'X-WR-CALNAME:Waseda Moodle',
        'BEGIN:VEVENT',
        'UID:wmm-due-1@example.com',
        'DTSTAMP:20261015T000000Z',
        'DTSTART:20261016T145900Z',
        'SUMMARY:Report',
        'STATUS:CONFIRMED',
        'TRANSP:OPAQUE',
        'END:VEVENT',
      ]),
    );
    expect(lines.some((l) => l.startsWith('DTEND'))).toBe(false);
  });

  it('writes optional fields escaped, tentative status and free time', () => {
    const ics = renderCalendar({
      name: 'x',
      stamp,
      events: [
        {
          ...base,
          end: base.start + 3_600_000,
          summary: 'Quiz; part 1, "easy"',
          description: 'Line one\nLine two',
          location: '11号館 502, 早稲田',
          url: 'https://wsdmoodle.waseda.jp/mod/quiz/view.php?id=1&x=2',
          tentative: true,
          free: true,
        },
      ],
    });
    const text = unfold(ics);
    expect(text).toContain('DTEND:20261016T155900Z\r\n');
    expect(text).toContain('SUMMARY:Quiz\\; part 1\\, "easy"\r\n');
    expect(text).toContain('DESCRIPTION:Line one\\nLine two\r\n');
    expect(text).toContain('LOCATION:11号館 502\\, 早稲田\r\n');
    expect(text).toContain('URL:https://wsdmoodle.waseda.jp/mod/quiz/view.php?id=1&x=2\r\n');
    expect(text).toContain('STATUS:TENTATIVE\r\n');
    expect(text).toContain('TRANSP:TRANSPARENT\r\n');
  });

  it('writes an all-day event on the JST date of its start, ending the next day', () => {
    const start = Date.UTC(2026, 9, 14, 15, 0, 0); // 00:00 on 10-15 in Tokyo
    const text = renderCalendar({ name: 'x', stamp, events: [{ ...base, start, end: start + 1, allDay: true }] });
    expect(text).toContain('DTSTART;VALUE=DATE:20261015\r\n');
    expect(text).toContain('DTEND;VALUE=DATE:20261016\r\n');
    expect(text).not.toContain('DTSTART:');
  });

  it('folds every physical line to at most 75 octets', () => {
    const ics = renderCalendar({
      name: 'x',
      stamp,
      events: [{ ...base, summary: '長い'.repeat(60), description: 'word '.repeat(80) }],
    });
    for (const line of ics.split('\r\n')) expect(octets(line)).toBeLessThanOrEqual(75);
    expect(unfold(ics)).toContain(`SUMMARY:${'長い'.repeat(60)}`);
  });

  it('is deterministic for the same input', () => {
    const a = renderCalendar({ name: 'x', stamp, events: [base] });
    expect(renderCalendar({ name: 'x', stamp, events: [base] })).toBe(a);
  });
});
