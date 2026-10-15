import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  MENTIONS_PER_TEXT,
  parseSnapshot,
  snapshotCmids,
} from '../../../src/core/services/sweep/snapshot';
import { stampChanges } from '../../../src/core/services/sweep/snapshot-diff';
import { BASE, NOW_MS, NOW_SEC, rawSection } from './helpers';

const env = { baseUrl: BASE, now: NOW_MS };
const none = new Map<number, string[]>();

describe('buildSnapshot', () => {
  const raw = [
    rawSection(
      1,
      [
        {
          id: 11,
          modname: 'assign',
          name: 'Essay &amp; Memo',
          state: 0,
          dates: [{ label: 'Due:', timestamp: NOW_SEC + 100, dataid: 'duedate' }],
        },
        { id: 12, modname: 'resource', name: 'Slides', files: ['a.pdf'], visible: 0 },
        { id: 13, modname: 'label', name: 'Notice', description: '<p>Report due on 10/18</p>' },
        { id: 14, modname: 'quiz', name: 'Practice', description: '<p>No date here</p>' },
      ],
      '<p>Submit by 10月15日 23:59</p>',
    ),
  ];

  it('maps modules compactly and keeps only date-bearing text', () => {
    const snap = buildSnapshot(raw, env);
    const mods = snap.s[0]?.m ?? [];
    expect(mods.map((m) => m.c)).toEqual([11, 12, 13, 14]);
    expect(mods[0]).toMatchObject({ n: 'Essay & Memo', t: 'assign', k: 0, d: { due: NOW_SEC + 100 } });
    expect(mods[1]).toMatchObject({
      v: 0,
      f: [['a.pdf', `${BASE}/webservice/pluginfile.php/1/a.pdf`, 10, 'application/pdf']],
    });
    expect(mods[3]?.k).toBeUndefined();
    expect(snap.x.map((t) => [t.k, t.r])).toEqual([
      ['section', 's9001'],
      ['label', 'm13'],
    ]);
    expect(snap.x[0]?.u).toBe(`${BASE}/course/section.php?id=9001`);
  });

  it('skips user-invisible modules and round-trips through JSON', () => {
    const hidden = [
      { ...rawSection(0, [{ id: 1, modname: 'url', name: 'x' }]), modules: [{ id: 1, uservisible: false }] },
    ];
    expect(buildSnapshot(hidden, env).s[0]?.m).toEqual([]);
    const snap = buildSnapshot(raw, env);
    expect(parseSnapshot(JSON.stringify(snap))).toEqual(snap);
    expect([...snapshotCmids(snap)]).toEqual([11, 12, 13, 14]);
    expect(parseSnapshot('not json')).toBeNull();
    expect(parseSnapshot('{"v":2}')).toBeNull();
  });
});

describe('stampChanges', () => {
  const first = buildSnapshot(
    [rawSection(1, [{ id: 1, modname: 'resource', name: 'A', files: ['a.pdf'] }], '<p>due 10/20</p>')],
    env,
  );

  it('stamps nothing without a previous snapshot', () => {
    const snap = stampChanges(structuredClone(first), null, { now: NOW_MS, updates: none });
    expect(snap.s[0]?.m[0]?.s).toBeUndefined();
    expect(snap.x[0]?.s).toBeUndefined();
  });

  it('new cmid gets firstSeen, existing keeps its stamp, changes record what', () => {
    const prev = structuredClone(first);
    const old = prev.s[0]?.m[0];
    if (old) old.s = 5;
    const cur = buildSnapshot(
      [
        rawSection(
          1,
          [
            { id: 1, modname: 'resource', name: 'A v2', files: ['a.pdf', 'b.pdf'] },
            { id: 2, modname: 'assign', name: 'B' },
          ],
          '<p>due 10/21</p>',
        ),
      ],
      env,
    );
    const out = stampChanges(cur, prev, { now: NOW_MS, updates: new Map([[1, ['configuration', 'completion']]]) });
    expect(out.s[0]?.m[0]).toMatchObject({ s: 5, a: NOW_MS, w: ['configuration', 'contentfiles'] });
    expect(out.s[0]?.m[1]).toMatchObject({ s: NOW_MS });
    expect(out.s[0]?.m[1]?.a).toBeUndefined();
    expect(out.x[0]?.s).toBe(NOW_MS); // text changed
  });

  it('an unchanged module keeps an older update stamp', () => {
    const prev = structuredClone(first);
    const m = prev.s[0]?.m[0];
    if (m) Object.assign(m, { a: 7, w: ['contentfiles'] });
    const out = stampChanges(structuredClone(first), prev, { now: NOW_MS, updates: none });
    expect(out.s[0]?.m[0]).toMatchObject({ a: 7, w: ['contentfiles'] });
    expect(out.x[0]?.s).toBeUndefined();
  });
});

describe('upcoming deadlines of a text', () => {
  it('stores the upcoming ones only, past dates never take a slot', () => {
    const past = Array.from({ length: 6 }, (_, i) => `10/${i + 1} Report ${i + 1} due`);
    const text = `<p>${[...past, '10/20 Report 7 due', '10/27 Report 8 due'].join('<br>')}</p>`;
    const snap = buildSnapshot([rawSection(1, [], text)], env);
    expect(snap.x[0]?.d?.map((m) => m[0])).toEqual([
      Date.parse('2026-10-20T23:59:00+09:00'),
      Date.parse('2026-10-27T23:59:00+09:00'),
    ]);
  });

  it('keeps up to MENTIONS_PER_TEXT of them and drops texts that only mention past dates', () => {
    const days = Array.from({ length: MENTIONS_PER_TEXT + 4 }, (_, i) => `Report due 10/${15 + i}`).join('<br>');
    const sections = [rawSection(1, [], `<p>${days}</p>`), rawSection(2, [], '<p>Report due 10/1</p>')];
    const snap = buildSnapshot(sections, env);
    expect(snap.x.map((t) => t.r)).toEqual(['s9001']);
    expect(snap.x[0]?.d).toHaveLength(MENTIONS_PER_TEXT);
  });
});

describe('stampChanges on long texts', () => {
  const filler = 'lorem ipsum '.repeat(250); // 3000 chars
  const textOf = (tail: string) => buildSnapshot([rawSection(1, [], `<p>Report due 10/20 ${filler}${tail}</p>`)], env);

  it('flags a change after the stored 2000 chars as new, and an identical text as unchanged', () => {
    const prev = textOf('');
    expect(prev.x[0]?.x.length).toBe(2000);
    const same = stampChanges(textOf(''), prev, { now: NOW_MS, updates: none });
    expect(same.x[0]?.s).toBeUndefined();
    const edited = stampChanges(textOf('Also due 10/25'), prev, { now: NOW_MS, updates: none });
    expect(edited.x[0]?.s).toBe(NOW_MS);
  });

  it('a snapshot stored without hashes is unchanged unless a deadline is gone or the body differs', () => {
    const legacy = () => {
      const old = textOf('');
      const t = old.x[0];
      if (t) {
        t.h = undefined;
        t.x = `${t.x.slice(0, 1990)}…`; // the old body was cut with an ellipsis
      }
      return old;
    };
    const unchanged = stampChanges(textOf(''), legacy(), { now: NOW_MS, updates: none });
    expect(unchanged.x[0]?.s).toBeUndefined();

    const lost = legacy();
    lost.x[0]?.d?.push([Date.parse('2026-10-19T12:00:00+09:00'), 'Report due 10/19', '']);
    expect(stampChanges(textOf(''), lost, { now: NOW_MS, updates: none }).x[0]?.s).toBe(NOW_MS);

    const edited = legacy();
    const t = edited.x[0];
    if (t) t.x = `Other ${t.x}`;
    expect(stampChanges(textOf(''), edited, { now: NOW_MS, updates: none }).x[0]?.s).toBe(NOW_MS);
  });
});
