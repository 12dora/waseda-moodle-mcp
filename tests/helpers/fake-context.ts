/**
 * Test doubles for services: a fake MoodleApi (fn -> canned response or function), an in-memory Store
 * covering the commonly needed methods (anything else throws), and a ServiceContext that wires them.
 * Generic on purpose; other service tests can reuse it.
 */

import type {
  ActionRow,
  AuditRow,
  CourseIndexRow,
  DraftUploadResult,
  MoodleApi,
  ServiceContext,
  Signer,
  Store,
  UploadDraftRow,
  UserRow,
} from '../../src/core/context';
import { MoodleError } from '../../src/core/errors';
import type { Scope, UserSettings } from '../../src/core/types';
import { DEFAULT_SETTINGS } from '../../src/core/types';

// ------------------------------------------------------------------ fake Moodle

type FakeParams = Record<string, unknown>;
/** A value is returned as-is; an Error is thrown; a function is called with the params (its result obeys the same rules). */
type FakeResponse = unknown | Error | ((params: FakeParams, callIndex: number) => unknown | Promise<unknown>);

interface FakeMoodle extends MoodleApi {
  calls: Array<{ fn: string; params: FakeParams }>;
  /** Number of real (non-memoised) calls to `fn`. */
  count(fn: string): number;
  /** Replace or add a response after construction. */
  set(fn: string, response: FakeResponse): void;
}

interface FakeMoodleOptions {
  baseUrl?: string;
  moodleUserId?: number;
  /** Memoise reads per (fn, params) like the real client does. Default true. */
  memoize?: boolean;
  fetchFile?: MoodleApi['fetchFile'];
  uploadToDraft?: MoodleApi['uploadToDraft'];
}

const WRITE_FN = /save|submit|add|send|update|create|delete|view_|mark/;

function makeFakeMoodle(responses: Record<string, FakeResponse> = {}, opts: FakeMoodleOptions = {}): FakeMoodle {
  const table = new Map<string, FakeResponse>(Object.entries(responses));
  const memo = new Map<string, Promise<unknown>>();
  const calls: FakeMoodle['calls'] = [];
  const memoize = opts.memoize ?? true;

  const run = async (fn: string, params: FakeParams): Promise<unknown> => {
    calls.push({ fn, params });
    if (!table.has(fn)) throw new MoodleError(`No fake response registered for ${fn}`, 'fake_missing');
    const res = table.get(fn);
    const value = typeof res === 'function' ? await res(params, calls.length - 1) : res;
    if (value instanceof Error) throw value;
    return structuredClone(value);
  };

  const api: FakeMoodle = {
    baseUrl: opts.baseUrl ?? 'https://moodle.example.edu',
    moodleUserId: opts.moodleUserId ?? 1001,
    get callsMade() {
      return calls.length;
    },
    calls,
    count: (fn) => calls.filter((c) => c.fn === fn).length,
    set: (fn, response) => {
      table.set(fn, response);
      memo.clear();
    },
    call: <T>(fn: string, params: FakeParams = {}) => {
      if (!memoize || WRITE_FN.test(fn)) return run(fn, params) as Promise<T>;
      const key = `${fn}\u0000${JSON.stringify(params)}`;
      let p = memo.get(key);
      if (!p) {
        p = run(fn, params);
        memo.set(key, p);
      }
      return p as Promise<T>;
    },
    fetchFile: opts.fetchFile ?? (() => Promise.reject(new Error('fake fetchFile not provided'))),
    uploadToDraft:
      opts.uploadToDraft ??
      ((): Promise<DraftUploadResult> => Promise.reject(new Error('fake uploadToDraft not provided'))),
  };
  return api;
}

// ------------------------------------------------------------------ fake Store

interface FakeStoreState {
  users: Map<number, UserRow>;
  courseIndex: Map<string, CourseIndexRow>; // `${userId}:${courseId}`
  actions: Map<string, ActionRow>;
  uploadDrafts: Map<string, UploadDraftRow>;
  audit: AuditRow[];
  /** Every putCourseIndex call, in order. */
  indexWrites: CourseIndexRow[];
}

export interface FakeStore {
  store: Store;
  state: FakeStoreState;
}

export function makeFakeStore(init: { courseIndex?: CourseIndexRow[]; users?: UserRow[] } = {}): FakeStore {
  const state: FakeStoreState = {
    users: new Map((init.users ?? []).map((u) => [u.id, u])),
    courseIndex: new Map((init.courseIndex ?? []).map((r) => [`${r.userId}:${r.courseId}`, r])),
    actions: new Map(),
    uploadDrafts: new Map(),
    audit: [],
    indexWrites: [],
  };

  const impl: Partial<Store> = {
    getUser: async (id) => state.users.get(id) ?? null,

    getCourseIndex: async (userId) => [...state.courseIndex.values()].filter((r) => r.userId === userId),
    putCourseIndex: async (row) => {
      state.indexWrites.push(row);
      state.courseIndex.set(`${row.userId}:${row.courseId}`, row);
    },

    createAction: async (row) => void state.actions.set(row.id, row),
    getAction: async (id) => state.actions.get(id) ?? null,
    updateAction: async (id, patch) => {
      const cur = state.actions.get(id);
      if (cur) state.actions.set(id, { ...cur, ...patch });
    },
    claimAction: async (id, userId, now) => {
      const cur = state.actions.get(id);
      if (!cur || cur.userId !== userId || cur.status !== 'pending' || cur.expiresAt <= now) return false;
      state.actions.set(id, { ...cur, status: 'executing' });
      return true;
    },
    listActions: async (userId, o) =>
      [...state.actions.values()]
        .filter((a) => a.userId === userId && (!o.status || a.status === o.status))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, o.limit),

    createUploadDraft: async (row) => void state.uploadDrafts.set(row.id, row),
    getUploadDraft: async (id) => state.uploadDrafts.get(id) ?? null,
    consumeUploadDraft: async (id) => {
      const cur = state.uploadDrafts.get(id);
      if (!cur || cur.expiresAt <= Date.now()) return false;
      state.uploadDrafts.set(id, { ...cur, expiresAt: 0 });
      return true;
    },
    appendUploadedFile: async (id, file) => {
      const cur = state.uploadDrafts.get(id);
      if (cur) {
        state.uploadDrafts.set(id, { ...cur, files: [...cur.files, file], totalBytes: cur.totalBytes + file.size });
      }
    },

    audit: async (row) => void state.audit.push(row),
    listAudit: async (userId, o) =>
      state.audit
        .filter((r) => r.userId === userId)
        .reverse()
        .slice(0, o.limit),
  };

  // Methods nobody implemented fail loudly instead of returning undefined.
  const store = new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof Store];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return () => {
        throw new Error(`FakeStore.${prop} is not implemented`);
      };
    },
  }) as Store;

  return { store, state };
}

// ------------------------------------------------------------------ fake Signer + context

const fakeSigner: Signer = {
  async sign(payload, ttlSec) {
    return `fake.${btoa(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }))}`;
  },
  async verify<T extends Record<string, unknown>>(ticket: string) {
    if (!ticket.startsWith('fake.')) return null;
    try {
      const payload = JSON.parse(atob(ticket.slice(5))) as T & { exp: number };
      return payload.exp < Math.floor(Date.now() / 1000) ? null : payload;
    } catch {
      return null;
    }
  },
};

function makeUser(patch: Partial<Omit<UserRow, 'settings'>> & { settings?: Partial<UserSettings> } = {}): UserRow {
  const { settings, ...rest } = patch;
  return {
    id: 1,
    moodleUserId: 1001,
    fullname: 'Taro Yamada',
    lang: 'en',
    createdAt: 0,
    lastSeenAt: null,
    ...rest,
    settings: { ...DEFAULT_SETTINGS, ...settings },
  };
}

export interface FakeContextOptions extends FakeMoodleOptions {
  responses?: Record<string, FakeResponse>;
  user?: Parameters<typeof makeUser>[0];
  store?: FakeStore;
  scopes?: Scope[];
  mode?: 'worker' | 'stdio';
  publicUrl?: string;
  source?: string;
}

export interface FakeContext {
  ctx: ServiceContext;
  api: FakeMoodle;
  store: Store;
  state: FakeStoreState;
  /** Promises passed to ctx.defer. */
  deferred: Promise<unknown>[];
}

export function makeFakeContext(opts: FakeContextOptions = {}): FakeContext {
  const api = makeFakeMoodle(opts.responses, opts);
  const fake = opts.store ?? makeFakeStore();
  const deferred: Promise<unknown>[] = [];
  const user = makeUser({ moodleUserId: api.moodleUserId, ...opts.user });
  fake.state.users.set(user.id, user);
  const ctx: ServiceContext = {
    user,
    store: fake.store,
    signer: fakeSigner,
    moodle: async () => api,
    publicUrl: opts.publicUrl ?? 'https://wasemoodle.example.com',
    mode: opts.mode ?? 'worker',
    scopes: opts.scopes ?? ['moodle:read'],
    source: opts.source ?? 'Test',
    defer: (p) => void deferred.push(p),
  };
  return { ctx, api, store: fake.store, state: fake.state, deferred };
}
