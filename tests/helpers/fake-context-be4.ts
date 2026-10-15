/** In-memory Store, fake MoodleApi, fake Signer and a ServiceContext builder for the BE-4 service tests. */

import type {
  ActionRow,
  ApiKeyRow,
  AuditRow,
  CourseSnapshotRow,
  CredentialRow,
  DraftUploadResult,
  MoodleApi,
  ServiceContext,
  SessionRow,
  Signer,
  Store,
  UploadDraftRow,
  UserRow,
} from '../../src/core/context';
import { MoodleError } from '../../src/core/errors';
import { DEFAULT_SETTINGS, type Scope, type UploadedDraftFile, type UserSettings } from '../../src/core/types';

export const BASE_URL = 'https://wsdmoodle.waseda.jp';
export const PUBLIC_URL = 'https://wasemoodle.example.com';

// ------------------------------------------------------------------ store

export interface MemoryStore extends Store {
  readonly users: Map<number, UserRow>;
  readonly credentials: Map<number, CredentialRow>;
  readonly actions: Map<string, ActionRow>;
  readonly uploads: Map<string, UploadDraftRow>;
  readonly auditLog: AuditRow[];
}

export function createMemoryStoreForTests(): MemoryStore {
  const users = new Map<number, UserRow>();
  const credentials = new Map<number, CredentialRow>();
  const sessions = new Map<string, SessionRow>();
  const keys = new Map<string, ApiKeyRow>();
  const actions = new Map<string, ActionRow>();
  const uploads = new Map<string, UploadDraftRow>();
  const snapshots = new Map<string, CourseSnapshotRow>();
  const syllabus = new Map<string, { json: string; fetchedAt: number }>();
  const auditLog: AuditRow[] = [];
  let nextUserId = 1;
  let nextAuditId = 1;

  const store: MemoryStore = {
    users,
    credentials,
    actions,
    uploads,
    auditLog,

    async getUser(id) {
      return users.get(id) ?? null;
    },
    async getUserByMoodleId(moodleUserId) {
      return [...users.values()].find((u) => u.moodleUserId === moodleUserId) ?? null;
    },
    async upsertUser(input) {
      const existing = [...users.values()].find((u) => u.moodleUserId === input.moodleUserId);
      if (existing) {
        existing.fullname = input.fullname;
        existing.lang = input.lang;
        return existing;
      }
      const row: UserRow = {
        id: nextUserId++,
        moodleUserId: input.moodleUserId,
        fullname: input.fullname,
        lang: input.lang,
        settings: { ...DEFAULT_SETTINGS },
        createdAt: Date.now(),
        lastSeenAt: null,
      };
      users.set(row.id, row);
      return row;
    },
    async updateSettings(userId, settings) {
      const u = users.get(userId);
      if (u) u.settings = settings;
    },
    async touchUser(userId, at) {
      const u = users.get(userId);
      if (u) u.lastSeenAt = at;
    },
    async deleteUser(userId) {
      users.delete(userId);
      credentials.delete(userId);
      for (const [k, a] of actions) if (a.userId === userId) actions.delete(k);
      for (const [k, a] of uploads) if (a.userId === userId) uploads.delete(k);
    },

    async getCredential(userId) {
      return credentials.get(userId) ?? null;
    },
    async putCredential(row) {
      credentials.set(row.userId, { ...row });
    },
    async updateCredentialStatus(userId, patch) {
      const c = credentials.get(userId);
      if (!c) return;
      if (patch.status !== undefined) c.status = patch.status;
      if (patch.lastOkAt !== undefined) c.lastOkAt = patch.lastOkAt;
      if (patch.lastError !== undefined) c.lastError = patch.lastError;
    },

    async createSession(row) {
      sessions.set(row.idHash, row);
    },
    async getSession(idHash) {
      return sessions.get(idHash) ?? null;
    },
    async touchSession(idHash, at, expiresAt) {
      const s = sessions.get(idHash);
      if (s) Object.assign(s, { lastSeenAt: at, expiresAt });
    },
    async deleteSession(idHash) {
      sessions.delete(idHash);
    },
    async deleteUserSessions(userId) {
      for (const [k, s] of sessions) if (s.userId === userId) sessions.delete(k);
    },

    async createApiKey(row) {
      keys.set(row.id, row);
    },
    async listApiKeys(userId) {
      return [...keys.values()].filter((k) => k.userId === userId).sort((a, b) => b.createdAt - a.createdAt);
    },
    async getApiKeyByHash(keyHash) {
      return [...keys.values()].find((k) => k.keyHash === keyHash) ?? null;
    },
    async revokeApiKey(userId, id, at) {
      const k = keys.get(id);
      if (!k || k.userId !== userId || k.revokedAt) return false;
      k.revokedAt = at;
      return true;
    },
    async touchApiKey(id, at) {
      const k = keys.get(id);
      if (k) k.lastUsedAt = at;
    },

    async createAction(row) {
      actions.set(row.id, { ...row });
    },
    async getAction(id) {
      const a = actions.get(id);
      return a ? { ...a } : null;
    },
    async claimAction(id, userId, now) {
      const a = actions.get(id);
      if (!a || a.userId !== userId || a.status !== 'pending' || a.expiresAt <= now) return false;
      a.status = 'executing';
      return true;
    },
    async updateAction(id, patch) {
      const a = actions.get(id);
      if (a) Object.assign(a, patch);
    },
    async listActions(userId, opts) {
      return [...actions.values()]
        .filter(
          (a) =>
            a.userId === userId &&
            (!opts.status || a.status === opts.status) &&
            (opts.before === undefined || a.createdAt < opts.before),
        )
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, opts.limit)
        .map((a) => ({ ...a }));
    },

    async createUploadDraft(row) {
      uploads.set(row.id, { ...row, files: [...row.files] });
    },
    async getUploadDraft(id) {
      const u = uploads.get(id);
      return u ? { ...u, files: [...u.files] } : null;
    },
    async consumeUploadDraft(id) {
      const u = uploads.get(id);
      if (!u || u.expiresAt <= Date.now()) return false;
      u.expiresAt = 0;
      return true;
    },
    async appendUploadedFile(id, file: UploadedDraftFile) {
      const u = uploads.get(id);
      if (!u) return;
      u.files.push(file);
      u.totalBytes += file.size;
    },

    async getCourseSnapshots(userId) {
      return [...snapshots.values()].filter((r) => r.userId === userId);
    },
    async putCourseSnapshot(row) {
      snapshots.set(`${row.userId}:${row.courseId}`, row);
    },
    async touchCourseSnapshot(userId, courseId, checkedAt) {
      const cur = snapshots.get(`${userId}:${courseId}`);
      if (cur) snapshots.set(`${userId}:${courseId}`, { ...cur, checkedAt });
    },
    async getSyllabusCache(idnumbers) {
      const out = new Map<string, { json: string; fetchedAt: number }>();
      for (const id of idnumbers) {
        const row = syllabus.get(id);
        if (row) out.set(id, row);
      }
      return out;
    },
    async putSyllabusCache(idnumber, json, fetchedAt) {
      syllabus.set(idnumber, { json, fetchedAt });
    },
    async listSweepUsers(limit) {
      return [...users.values()].slice(0, limit);
    },
    async markSwept() {},
    async setScopeCourseIds() {},
    async getInferredSchedules() {
      return new Map();
    },
    async putInferredSchedules() {},
    async getCalendarFeed() {
      return null;
    },
    async getCalendarFeedByHash() {
      return null;
    },
    async replaceCalendarFeed() {},
    async deleteCalendarFeed() {
      return false;
    },
    async recordCalendarFetch() {},

    async audit(row) {
      auditLog.push({ ...row, id: nextAuditId++ });
    },
    async listAudit(userId, opts) {
      return auditLog
        .filter((r) => r.userId === userId && (opts.before === undefined || r.at < opts.before))
        .sort((a, b) => b.at - a.at)
        .slice(0, opts.limit);
    },
  };
  return store;
}

// ------------------------------------------------------------------ signer

function b64urlOfUtf8(s: string): string {
  const bin = Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join('');
  return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function utf8OfB64url(s: string): string {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Deterministic, unkeyed stand-in: `<b64(json)>.sig`. Honours exp like the real one. */
function createFakeSigner(): Signer {
  return {
    async sign(payload, ttlSec) {
      const json = JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec });
      return `${b64urlOfUtf8(json)}.sig`;
    },
    async verify<T extends Record<string, unknown>>(ticket: string) {
      const [body, sig] = ticket.split('.');
      if (!body || sig !== 'sig') return null;
      try {
        const p = JSON.parse(utf8OfB64url(body)) as T & { exp?: number };
        if (typeof p.exp !== 'number' || p.exp < Math.floor(Date.now() / 1000)) return null;
        return p;
      } catch {
        return null;
      }
    },
  };
}

// ------------------------------------------------------------------ fake Moodle

interface FakeFile {
  body: Uint8Array | string;
  contentType?: string;
  contentDisposition?: string;
  status?: number;
}

interface UploadRecord {
  name: string;
  bytes: Uint8Array;
  itemId: number;
  mime: string | null;
  declaredSize: number;
}

export interface FakeMoodle extends MoodleApi {
  /** wsfunction -> response (value, or function of params; throw to simulate an error). */
  handlers: Record<string, unknown | ((params: Record<string, unknown>) => unknown)>;
  calls: Array<{ fn: string; params: Record<string, unknown> }>;
  /** Absolute file URL (no token) -> served content. */
  files: Map<string, FakeFile>;
  fetched: Array<{ url: string; method: string; range?: string }>;
  uploads: UploadRecord[];
  callsTo(fn: string): Array<Record<string, unknown>>;
}

const toBytes = (b: Uint8Array | string) => (typeof b === 'string' ? new TextEncoder().encode(b) : b);

async function drain(body: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export function createFakeMoodle(opts: { moodleUserId?: number; handlers?: FakeMoodle['handlers'] } = {}): FakeMoodle {
  let nextItem = 9000;
  const api: FakeMoodle = {
    baseUrl: BASE_URL,
    moodleUserId: opts.moodleUserId ?? 1001,
    callsMade: 0,
    handlers: { ...(opts.handlers ?? {}) },
    calls: [],
    files: new Map(),
    fetched: [],
    uploads: [],
    callsTo(fn) {
      return api.calls.filter((c) => c.fn === fn).map((c) => c.params);
    },
    async call<T>(fn: string, params: Record<string, unknown> = {}) {
      (api as { callsMade: number }).callsMade++;
      api.calls.push({ fn, params });
      if (fn === 'core_files_get_unused_draft_itemid' && !(fn in api.handlers)) {
        return { itemid: nextItem++, warnings: [] } as T;
      }
      if (!(fn in api.handlers)) throw new MoodleError(`fake: no handler for ${fn}`, 'nohandler');
      const h = api.handlers[fn];
      return (typeof h === 'function' ? (h as (p: Record<string, unknown>) => unknown)(params) : h) as T;
    },
    async fetchFile(fileUrl, init) {
      const method = init?.method ?? 'GET';
      api.fetched.push({ url: fileUrl, method, range: init?.range });
      const f = api.files.get(fileUrl);
      if (!f) return new Response('not found', { status: 404 });
      const bytes = toBytes(f.body);
      const headers = new Headers({
        'content-type': f.contentType ?? 'application/octet-stream',
        'content-length': String(bytes.length),
      });
      if (f.contentDisposition) headers.set('content-disposition', f.contentDisposition);
      return new Response(method === 'HEAD' ? null : (bytes as unknown as BodyInit), {
        status: f.status ?? 200,
        headers,
      });
    },
    async uploadToDraft(file, itemId): Promise<DraftUploadResult> {
      const bytes = await drain(file.body);
      const id = itemId || nextItem++;
      if (api.uploads.some((u) => u.itemId === id && u.name === file.name)) {
        throw new MoodleError('A file with that name already exists.', 'filenameexist');
      }
      api.uploads.push({ name: file.name, bytes, itemId: id, mime: file.mime ?? null, declaredSize: file.size });
      return { itemid: id, filename: file.name, filesize: bytes.length };
    },
  };
  return api;
}

// ------------------------------------------------------------------ context

export function makeUser(
  overrides: Omit<Partial<UserRow>, 'settings'> & { settings?: Partial<UserSettings> } = {},
): UserRow {
  const { settings, ...rest } = overrides;
  return {
    id: 1,
    moodleUserId: 1001,
    fullname: 'Taro Yamada',
    lang: 'en',
    createdAt: Date.UTC(2026, 9, 1),
    lastSeenAt: null,
    ...rest,
    settings: { ...DEFAULT_SETTINGS, ...settings },
  };
}

export interface TestContext {
  ctx: ServiceContext;
  store: MemoryStore;
  moodle: FakeMoodle;
  signer: Signer;
  deferred: Promise<unknown>[];
}

export function createTestContext(
  opts: {
    user?: UserRow;
    scopes?: Scope[];
    mode?: 'worker' | 'stdio';
    source?: string;
    handlers?: FakeMoodle['handlers'];
    store?: MemoryStore;
  } = {},
): TestContext {
  const store = opts.store ?? createMemoryStoreForTests();
  const user = opts.user ?? makeUser();
  store.users.set(user.id, user);
  const moodle = createFakeMoodle({ moodleUserId: user.moodleUserId, handlers: opts.handlers });
  const signer = createFakeSigner();
  const deferred: Promise<unknown>[] = [];
  const mode = opts.mode ?? 'worker';
  const ctx: ServiceContext = {
    user,
    store,
    signer,
    moodle: async () => moodle,
    publicUrl: mode === 'stdio' ? '' : PUBLIC_URL,
    mode,
    scopes: opts.scopes ?? ['moodle:read', 'moodle:write'],
    source: opts.source ?? 'Test Client',
    defer: (p) => {
      deferred.push(p);
    },
  };
  return { ctx, store, moodle, signer, deferred };
}
