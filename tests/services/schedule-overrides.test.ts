import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInput } from '../../src/core/errors';
import {
  applyScheduleOverrides,
  normalizeScheduleOverrides,
  setScheduleOverride,
  validateScheduleOverrides,
} from '../../src/core/services/schedule-overrides';
import { resolveScope } from '../../src/core/services/scope';
import type { ScheduleOverride } from '../../src/core/types';
import { makeFakeContext } from '../helpers/fake-context';

vi.mock('../../src/core/services/scope', () => ({ resolveScope: vi.fn() }));

const ENROLLED = [101, 102, 300907];
const slot = (over: Partial<ScheduleOverride['slots'][number]> = {}) => ({
  weekday: 5,
  periodFrom: 1,
  periodTo: 2,
  classroom: '22-909' as string | null,
  ...over,
});
const slots = (...s: ScheduleOverride['slots']): ScheduleOverride => ({ mode: 'slots', slots: s });

function setup(overrides: Record<string, ScheduleOverride> = {}) {
  const t = makeFakeContext({ user: { settings: { scheduleOverrides: overrides } } });
  vi.mocked(resolveScope).mockResolvedValue({
    mode: 'mine',
    mine: new Set(ENROLLED),
    courses: ENROLLED.map((id) => ({ id })),
  } as never);
  return t;
}

const settingsOf = (t: ReturnType<typeof setup>) => t.state.users.get(t.ctx.user.id)?.settings;

beforeEach(() => {
  vi.mocked(resolveScope).mockReset();
});

describe('setScheduleOverride', () => {
  it('saves slots for an enrolled course, keeps the other settings and returns the new map', async () => {
    const t = setup();
    const map = await setScheduleOverride(t.ctx, 300907, slots(slot()));
    expect(map).toEqual({ '300907': slots(slot()) });
    expect(settingsOf(t)).toMatchObject({ writeMode: 'chat', myCourseIds: null, scheduleOverrides: map });
    expect(t.ctx.user.settings.scheduleOverrides).toEqual(map);
    expect(t.state.audit).toMatchObject([
      { action: 'settings:schedule_override', actor: 'mcp:Test', detail: { changed: 1, total: 1 } },
    ]);
  });

  it('replaces one course and leaves the others; null removes only that course', async () => {
    const other = slots(slot({ weekday: 1, periodFrom: 3, periodTo: 3, classroom: null }));
    const t = setup({ '101': other, '300907': slots(slot()) });
    const replaced = await setScheduleOverride(t.ctx, 300907, { mode: 'on-demand', slots: [] });
    expect(replaced).toEqual({ '101': other, '300907': { mode: 'on-demand', slots: [] } });
    expect(await setScheduleOverride(t.ctx, 300907, null)).toEqual({ '101': other });
    expect(settingsOf(t)?.scheduleOverrides).toEqual({ '101': other });
  });

  it('removes an entry without any Moodle lookup, even for a course no longer enrolled', async () => {
    const t = setup({ '555': slots(slot()) });
    expect(await setScheduleOverride(t.ctx, 555, null)).toEqual({});
    expect(resolveScope).not.toHaveBeenCalled();
  });

  it('trims the classroom, turns blank into null and drops slots from the other modes', async () => {
    const t = setup();
    const raw = [slot({ classroom: '  22-909  ' }), slot({ weekday: 2, classroom: '   ' })];
    const map = await setScheduleOverride(t.ctx, 101, slots(...raw, slot({ weekday: 3, classroom: undefined })));
    expect(map['101']?.slots.map((s) => s.classroom)).toEqual(['22-909', null, null]);
    const none = await setScheduleOverride(t.ctx, 102, { mode: 'none', slots: [slot()] });
    expect(none['102']).toEqual({ mode: 'none', slots: [] });
  });

  it('rejects a course the user is not enrolled in and writes nothing', async () => {
    const t = setup();
    await expect(setScheduleOverride(t.ctx, 999, slots(slot()))).rejects.toThrow('Not enrolled in course(s): 999.');
    expect(t.state.users.get(t.ctx.user.id)?.settings.scheduleOverrides).toEqual({});
    expect(t.state.audit).toEqual([]);
  });

  it.each([
    ['weekday 0', slots(slot({ weekday: 0 }))],
    ['weekday 8', slots(slot({ weekday: 8 }))],
    ['fractional weekday', slots(slot({ weekday: 1.5 }))],
    ['period 0', slots(slot({ periodFrom: 0 }))],
    ['period 8', slots(slot({ periodTo: 8 }))],
    ['periodFrom after periodTo', slots(slot({ periodFrom: 3, periodTo: 2 }))],
    ['a 41 character classroom', slots(slot({ classroom: 'x'.repeat(41) }))],
    ['no slots in mode slots', slots()],
    ['7 slots', slots(...Array.from({ length: 7 }, () => slot()))],
    ['an unknown mode', { mode: 'weekly', slots: [] } as unknown as ScheduleOverride],
    ['a non-text classroom', slots(slot({ classroom: 5 as unknown as string }))],
    ['a slot that is not an object', slots(5 as unknown as ReturnType<typeof slot>)],
  ])('rejects %s', async (_name, override) => {
    const t = setup();
    await expect(setScheduleOverride(t.ctx, 101, override)).rejects.toBeInstanceOf(InvalidInput);
    expect(t.state.audit).toEqual([]);
  });

  it('accepts the limits: 6 slots, periods 1-7, weekdays 1-7 and a 40 character classroom', async () => {
    const t = setup();
    const edge = slot({ weekday: 7, periodFrom: 1, periodTo: 7, classroom: 'x'.repeat(40) });
    const map = await setScheduleOverride(t.ctx, 101, slots(...Array.from({ length: 6 }, () => edge)));
    expect(map['101']?.slots).toHaveLength(6);
  });

  it('allows at most 60 overrides in total', async () => {
    const others = Array.from({ length: 59 }, (_, i) => [String(1000 + i), slots(slot())]);
    const t = setup({ '101': slots(slot()), ...Object.fromEntries(others) });
    await expect(setScheduleOverride(t.ctx, 102, slots(slot()))).rejects.toThrow('At most 60');
    expect(t.state.audit).toEqual([]);
    // replacing an existing entry does not grow the map
    expect(Object.keys(await setScheduleOverride(t.ctx, 101, slots(slot({ weekday: 2 }))))).toHaveLength(60);
  });
});

describe('validateScheduleOverrides / applyScheduleOverrides', () => {
  it('validates every entry before anything is applied: nothing is written when one is bad', async () => {
    const t = setup();
    const raw = { '101': slots(slot()), '102': { mode: 'slots', slots: [] } };
    await expect(validateScheduleOverrides(t.ctx, raw)).rejects.toBeInstanceOf(InvalidInput);
    expect(t.state.audit).toEqual([]);
    expect(settingsOf(t)?.scheduleOverrides).toEqual({});
  });

  it('returns the changes (null = remove) and applies them in one settings write', async () => {
    const t = setup({ '102': slots(slot()) });
    const raw = { '101': slots(slot({ periodFrom: 4, periodTo: 4 })), '102': null };
    const changes = await validateScheduleOverrides(t.ctx, raw);
    expect([...changes.keys()]).toEqual([101, 102]);
    expect(changes.get(102)).toBeNull();
    expect(settingsOf(t)?.scheduleOverrides).toEqual({ '102': slots(slot()) }); // validation alone writes nothing
    const next = await applyScheduleOverrides(t.ctx, changes);
    expect(next).toEqual({ '101': slots(slot({ periodFrom: 4, periodTo: 4 })) });
    expect(t.state.audit).toHaveLength(1);
    expect(await applyScheduleOverrides(t.ctx, new Map())).toEqual(next); // no change, no write
    expect(t.state.audit).toHaveLength(1);
  });

  it.each([
    ['an array', [slots(slot())]],
    ['a string', 'x'],
    ['null', null],
    ['a non-numeric key', { abc: slots(slot()) }],
    ['a zero key', { '0': slots(slot()) }],
    ['a key with leading zeros', { '0101': slots(slot()) }],
    ['a decimal key', { '1.5': slots(slot()) }],
    ['a key beyond the id range', { '99999999999': slots(slot()) }],
    ['more than 60 entries', Object.fromEntries(Array.from({ length: 61 }, (_, i) => [String(i + 1), null]))],
  ])('rejects %s', async (_name, raw) => {
    const t = setup();
    await expect(validateScheduleOverrides(t.ctx, raw)).rejects.toBeInstanceOf(InvalidInput);
  });
});

describe('normalizeScheduleOverrides', () => {
  it('keeps valid entries and drops everything else', () => {
    const good = slots(slot());
    const stored = {
      '300907': good,
      '12': { mode: 'none', slots: [slot()] }, // slots are dropped outside mode slots
      '13': { mode: 'slots', slots: [] },
      '0': good,
      x: good,
      '14': 'nope',
    };
    expect(normalizeScheduleOverrides(stored)).toEqual({ '300907': good, '12': { mode: 'none', slots: [] } });
    for (const bad of [undefined, null, 'x', [good], 5]) expect(normalizeScheduleOverrides(bad)).toEqual({});
  });

  it('keeps at most 60 entries', () => {
    const many = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [String(i + 1), { mode: 'on-demand' }]));
    expect(Object.keys(normalizeScheduleOverrides(many))).toHaveLength(60);
  });
});
