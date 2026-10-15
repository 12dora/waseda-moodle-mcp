/**
 * Minimal RFC 5545 writer for the calendar feed: CRLF line ends, TEXT escaping, folding at 75 octets (never inside
 * a UTF-8 sequence) and UTC times (Japan has no DST, so JST wall-clock times convert with a fixed offset).
 */

import { isoJst } from '../../core/time';

const CRLF = '\r\n';
const MAX_OCTETS = 75;
const PRODID = '-//wasemoodle//Waseda Moodle MCP//EN';
const POLL_INTERVAL = 'PT30M';
const DAY_MS = 86_400_000;
const encoder = new TextEncoder();

export interface IcsEvent {
  uid: string;
  start: number; // unix ms
  end?: number; // unix ms; omitted = zero duration (deadlines); ignored for all-day events
  /** A whole-day event on the JST date of `start` (DTSTART;VALUE=DATE, one day long). */
  allDay?: boolean;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  tentative?: boolean;
  /** TRANSP:TRANSPARENT - the event does not mark the user as busy (deadlines). */
  free?: boolean;
}

/** Control characters other than the line break become spaces; CR LF pairs become one LF. */
function printable(s: string): string {
  return Array.from(s.replace(/\r\n?/g, '\n'), (ch) => {
    const code = ch.charCodeAt(0);
    return (code < 32 && code !== 10) || code === 127 ? ' ' : ch;
  }).join('');
}

/** TEXT value: backslash, semicolon and comma are escaped, a line break becomes the two characters `\n`. */
export function escapeText(s: string): string {
  return printable(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function octetsOf(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  return cp < 0x10000 ? 3 : 4;
}

/** Folds a content line at 75 octets; continuation lines start with one space, which counts toward their 75. */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= MAX_OCTETS) return line;
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  let limit = MAX_OCTETS;
  for (const ch of line) {
    const size = octetsOf(ch);
    if (octets + size > limit) {
      parts.push(current);
      current = '';
      octets = 0;
      limit = MAX_OCTETS - 1;
    }
    current += ch;
    octets += size;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

/** Unix ms -> '20261015T143000Z'. */
export function formatUtc(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** Unix ms -> '20261015' (the JST calendar date). */
function formatJstDate(ms: number): string {
  return isoJst(ms).slice(0, 10).replace(/-/g, '');
}

/** A JST wall-clock time ('YYYY-MM-DD', 'HH:MM') as unix ms. */
export function jstToMs(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+09:00`);
}

/** URI value: only control characters are dropped (a URI contains no commas or semicolons that need escaping). */
const uriValue = (s: string): string => printable(s).replace(/\n/g, '');

/** DTSTART (+ DTEND): UTC date-times, or for an all-day event the JST date and the (exclusive) next day. */
function timeLines(ev: IcsEvent): string[] {
  if (ev.allDay) {
    return [`DTSTART;VALUE=DATE:${formatJstDate(ev.start)}`, `DTEND;VALUE=DATE:${formatJstDate(ev.start + DAY_MS)}`];
  }
  const lines = [`DTSTART:${formatUtc(ev.start)}`];
  if (ev.end !== undefined) lines.push(`DTEND:${formatUtc(ev.end)}`);
  return lines;
}

function eventLines(ev: IcsEvent, stamp: number): string[] {
  const lines = ['BEGIN:VEVENT', `UID:${uriValue(ev.uid)}`, `DTSTAMP:${formatUtc(stamp)}`, ...timeLines(ev)];
  lines.push(`SUMMARY:${escapeText(ev.summary)}`);
  if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
  if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
  if (ev.url) lines.push(`URL:${uriValue(ev.url)}`);
  lines.push(`STATUS:${ev.tentative ? 'TENTATIVE' : 'CONFIRMED'}`);
  lines.push(`TRANSP:${ev.free ? 'TRANSPARENT' : 'OPAQUE'}`, 'END:VEVENT');
  return lines;
}

/** The whole VCALENDAR document (CRLF after every line, including the last). */
export function renderCalendar(opts: { name: string; stamp: number; events: readonly IcsEvent[] }): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(opts.name)}`,
    'X-WR-TIMEZONE:Asia/Tokyo',
    `REFRESH-INTERVAL;VALUE=DURATION:${POLL_INTERVAL}`,
    `X-PUBLISHED-TTL:${POLL_INTERVAL}`,
    ...opts.events.flatMap((ev) => eventLines(ev, opts.stamp)),
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join(CRLF) + CRLF;
}
