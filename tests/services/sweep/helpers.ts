import type { CourseSnapshotRow, MoodleApi, ServiceContext, Store } from '../../../src/core/context';
import type { Course } from '../../../src/core/types';

export const BASE = 'https://moodle.example.edu';
/** 2026-10-14 12:00 JST. */
export const NOW = new Date('2026-10-14T03:00:00Z');
export const NOW_MS = NOW.getTime();
export const NOW_SEC = NOW_MS / 1000;
export const MIN = 60_000;
export const DAY = 86_400_000;

export function course(id: number, name = `Course ${id}`): Course {
  return {
    id,
    name,
    shortName: `C${id}`,
    category: null,
    url: `${BASE}/course/view.php?id=${id}`,
    start: null,
    end: null,
    progress: null,
    kind: 'class',
    mine: true,
    suggested: true,
    term: null,
    lastAccess: null,
  };
}

export const scopeOf = (...courses: Course[]) => ({
  mode: 'mine' as const,
  mine: new Set(courses.map((c) => c.id)),
  courses,
});

// ------------------------------------------------------------------ raw Moodle shapes (synthetic)

export interface RawMod {
  id: number;
  modname: string;
  name: string;
  state?: number; // completiondata.state
  dates?: Array<{ label: string; timestamp: number; dataid: string }>;
  description?: string;
  visible?: number;
  files?: string[];
}

function rawModule(m: RawMod) {
  return {
    id: m.id,
    modname: m.modname,
    name: m.name,
    url: `${BASE}/mod/${m.modname}/view.php?id=${m.id}`,
    visible: m.visible ?? 1,
    uservisible: true,
    description: m.description ?? '',
    completion: m.state === undefined ? 0 : 1,
    completiondata: m.state === undefined ? undefined : { state: m.state, hascompletion: true },
    dates: m.dates ?? [],
    contents: (m.files ?? []).map((f) => ({
      type: 'file',
      filename: f,
      filesize: 10,
      fileurl: `${BASE}/webservice/pluginfile.php/1/${f}`,
      mimetype: 'application/pdf',
    })),
  };
}

export function rawSection(num: number, modules: RawMod[], summary = '', name = `Week ${num}`) {
  return { id: 9000 + num, name, section: num, summary, uservisible: true, modules: modules.map(rawModule) };
}

// ------------------------------------------------------------------ fake context

export type Handler = (params: Record<string, unknown>, n: number) => unknown;

export interface Fake {
  ctx: ServiceContext;
  calls: Array<{ fn: string; params: Record<string, unknown> }>;
  rows: Map<number, CourseSnapshotRow>;
  touched: number[];
  puts: number[];
}

export function makeFake(handlers: Record<string, Handler>, rows: CourseSnapshotRow[] = []): Fake {
  const calls: Fake['calls'] = [];
  const state = new Map(rows.map((r) => [r.courseId, r]));
  const touched: number[] = [];
  const puts: number[] = [];
  const counts = new Map<string, number>();
  const api = {
    baseUrl: BASE,
    moodleUserId: 1001,
    callsMade: 0,
    call: async (fn: string, params: Record<string, unknown> = {}) => {
      calls.push({ fn, params });
      const h = handlers[fn];
      if (!h) throw new Error(`unexpected call ${fn}`);
      const n = counts.get(fn) ?? 0;
      counts.set(fn, n + 1);
      return h(params, n);
    },
  } as unknown as MoodleApi;
  const store = {
    getCourseSnapshots: async () => [...state.values()],
    putCourseSnapshot: async (row: CourseSnapshotRow) => {
      puts.push(row.courseId);
      state.set(row.courseId, row);
    },
    touchCourseSnapshot: async (_u: number, courseId: number, checkedAt: number) => {
      touched.push(courseId);
      const cur = state.get(courseId);
      if (cur) state.set(courseId, { ...cur, checkedAt });
    },
  } as unknown as Store;
  const ctx = {
    user: { id: 1, moodleUserId: 1001 },
    store,
    moodle: async () => api,
    publicUrl: '',
    mode: 'stdio',
    scopes: ['moodle:read'],
    source: 'test',
    defer: () => {},
  } as unknown as ServiceContext;
  return { ctx, calls, rows: state, touched, puts };
}

export const snapshotRow = (courseId: number, json: string, checkedAt: number): CourseSnapshotRow => ({
  userId: 1,
  courseId,
  json,
  fetchedAt: checkedAt,
  checkedAt,
});
