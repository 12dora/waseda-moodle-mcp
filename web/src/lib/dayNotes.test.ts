import { describe, expect, it } from 'vitest';
import type { DayNote, TimetableDay } from '../api/types';
import { DICTIONARIES, type MessageKey, translate } from '../i18n/core';
import { type NoteContext, notesText, noteText, sharedBreaks } from './dayNotes';
import type { Lang } from './time';

const ctx = (lang: Lang): NoteContext => ({
  lang,
  t: (key: MessageKey, vars) => translate(DICTIONARIES[lang], key, vars),
});

const day = (date: string, notes: DayNote[]): TimetableDay => ({ date, weekday: 1, notes, classes: [] });

describe('noteText', () => {
  it('words each note kind', () => {
    const en = ctx('en');
    expect(noteText({ kind: 'closed', name: '臨時休業日' }, en)).toBe('No classes (臨時休業日)');
    expect(noteText({ kind: 'held', name: 'Sports Day' }, en)).toBe('Classes held (Sports Day)');
    expect(noteText({ kind: 'swap', weekday: 1 }, en)).toBe('Mon schedule');
    expect(noteText({ kind: 'winter-break' }, en)).toBe('Winter break');
  });

  it('localizes the swapped weekday', () => {
    expect(noteText({ kind: 'swap', weekday: 3 }, ctx('ja'))).toBe('水曜授業');
    expect(noteText({ kind: 'swap', weekday: 7 }, ctx('zh-CN'))).toBe('按周日课表上课');
  });
});

describe('notesText', () => {
  const notes: DayNote[] = [{ kind: 'term-break' }, { kind: 'held', name: 'X' }];

  it('joins notes', () => {
    expect(notesText(notes, ctx('en'))).toBe('Outside class period · Classes held (X)');
  });

  it('can leave out breaks', () => {
    expect(notesText(notes, { ...ctx('en'), skipBreaks: true })).toBe('Classes held (X)');
    expect(notesText([{ kind: 'winter-break' }], { ...ctx('en'), skipBreaks: true })).toBe('');
  });
});

describe('sharedBreaks', () => {
  it('returns distinct breaks when every day is in one', () => {
    const days = [
      day('2026-12-28', [{ kind: 'winter-break' }]),
      day('2026-12-29', [{ kind: 'winter-break' }]),
      day('2026-12-30', [{ kind: 'term-break' }, { kind: 'closed', name: 'Y' }]),
    ];
    expect(sharedBreaks(days)).toEqual([{ kind: 'winter-break' }, { kind: 'term-break' }]);
  });

  it('returns null when any day is not in a break', () => {
    expect(sharedBreaks([day('2026-10-12', [{ kind: 'term-break' }]), day('2026-10-13', [])])).toBeNull();
    expect(sharedBreaks([])).toBeNull();
  });
});
