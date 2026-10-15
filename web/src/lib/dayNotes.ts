/** Localized text for timetable day notes (contract §15.2 DayNote). */

import type { DayNote, TimetableDay } from '../api/types';
import type { Translate } from '../i18n/core';
import { type Lang, weekdayName } from './time';

export interface NoteContext {
  t: Translate;
  lang: Lang;
}

const isBreak = (n: DayNote) => n.kind === 'term-break' || n.kind === 'winter-break';

export function noteText(note: DayNote, { t, lang }: NoteContext): string {
  switch (note.kind) {
    case 'closed':
      return t('timetable.note.closed', { name: note.name });
    case 'held':
      return t('timetable.note.held', { name: note.name });
    case 'swap':
      return t('timetable.note.swap', { weekday: weekdayName(note.weekday, lang) });
    case 'term-break':
      return t('timetable.note.termBreak');
    case 'winter-break':
      return t('timetable.note.winterBreak');
  }
}

/** One line for a day's notes; `skipBreaks` leaves out breaks already shown in a shared notice. */
export function notesText(notes: DayNote[], ctx: NoteContext & { skipBreaks?: boolean }): string {
  const shown = ctx.skipBreaks ? notes.filter((n) => !isBreak(n)) : notes;
  return shown.map((n) => noteText(n, ctx)).join(' · ');
}

/** When every day is in a break: the distinct break notes for one notice above the grid; otherwise null. */
export function sharedBreaks(days: TimetableDay[]): DayNote[] | null {
  if (days.length === 0 || !days.every((d) => d.notes.some(isBreak))) return null;
  const seen = new Set<DayNote['kind']>();
  return days
    .flatMap((d) => d.notes.filter(isBreak))
    .filter((n) => {
      if (seen.has(n.kind)) return false;
      seen.add(n.kind);
      return true;
    });
}
