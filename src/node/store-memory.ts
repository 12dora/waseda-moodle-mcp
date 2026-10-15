/**
 * In-memory Store for the local single-user (stdio) entry.
 * Settings and write actions can be persisted to a JSON file so pending previews and preferences survive
 * restarts; credentials, sessions, API keys, uploads and the audit log stay in memory only.
 */

import { readFileSync } from 'node:fs';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  ActionRow,
  ApiKeyRow,
  AuditRow,
  CourseSnapshotRow,
  CredentialRow,
  SessionRow,
  Store,
  UploadDraftRow,
  UserRow,
} from '../core/context';
import { normalizeScheduleOverrides } from '../core/services/schedule-overrides';
import {
  type ActionStatus,
  DEFAULT_SETTINGS,
  type InferredSchedule,
  type UploadedDraftFile,
  type UserSettings,
} from '../core/types';

const MAX_AUDIT_ROWS = 1000;
/** Finished actions (executed, cancelled, expired, failed) are dropped from the state file after this long. */
const FINISHED_ACTION_TTL_MS = 30 * 24 * 3600 * 1000;
/** Inferred class times are dropped after this long without a check (the D1 store purges them the same way). */
const INFERRED_TTL_MS = 30 * 24 * 3600 * 1000;

interface PersistedState {
  version: 1;
  nextUserId: number;
  users: UserRow[];
  actions: ActionRow[];
  /** Kept across restarts so a new session does not start cold: public syllabus rows and the user's inferred times. */
  syllabus?: Record<string, { json: string; fetchedAt: number }>;
  inferred?: Record<string, InferredSchedule>;
}

interface MemoryStoreOptions {
  /** JSON file for users (settings), actions and lookup caches; mode 0600. Omit for a purely in-memory store. */
  persistPath?: string;
  /** Called when reading or writing the persistence file fails (default: ignore). */
  onPersistError?: (error: unknown) => void;
}

const clone = <T>(v: T): T => structuredClone(v);

/** Removes the rows of one user from a map keyed by anything. */
function dropOwnedBy(rows: Map<string, { userId: number }>, userId: number): void {
  for (const [k, v] of rows) if (v.userId === userId) rows.delete(k);
}

export class MemoryStore implements Store {
  private readonly users = new Map<number, UserRow>();
  private readonly credentials = new Map<number, CredentialRow>();
  private readonly sessions = new Map<string, SessionRow>();
  private readonly apiKeys = new Map<string, ApiKeyRow>();
  private readonly actions = new Map<string, ActionRow>();
  private readonly uploads = new Map<string, UploadDraftRow>();
  private readonly courseSnapshots = new Map<string, CourseSnapshotRow>();
  private readonly syllabusCache = new Map<string, { json: string; fetchedAt: number }>();
  private readonly inferredSchedules = new Map<string, InferredSchedule>(); // `${userId}:${courseId}`
  private readonly sweptAt = new Map<number, number>(); // not persisted: a restart sweeps everyone again
  private auditRows: AuditRow[] = [];
  private nextUserId = 1;
  private nextAuditId = 1;
  private readonly persistPath: string | undefined;
  private readonly onPersistError: (error: unknown) => void;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: MemoryStoreOptions = {}) {
    this.persistPath = opts.persistPath;
    this.onPersistError = opts.onPersistError ?? (() => undefined);
    if (this.persistPath) this.load(this.persistPath);
  }

  // ------------------------------------------------------------------ persistence

  private load(path: string): void {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.onPersistError(e);
      return;
    }
    try {
      this.restore(JSON.parse(raw) as Partial<PersistedState>);
    } catch (e) {
      this.onPersistError(e);
    }
  }

  private restore(data: Partial<PersistedState>): void {
    for (const u of data.users ?? []) {
      const merged = { ...DEFAULT_SETTINGS, ...u.settings };
      const settings: UserSettings = {
        // drops retired fields; an old file reads no overrides as {} and a missing night / alsoOnDemand as false
        writeMode: merged.writeMode,
        myCourseIds: merged.myCourseIds ?? null,
        uiLang: merged.uiLang,
        scheduleOverrides: normalizeScheduleOverrides(merged.scheduleOverrides),
      };
      this.users.set(u.id, { ...u, settings });
    }
    for (const a of data.actions ?? []) this.actions.set(a.id, a);
    for (const [k, v] of Object.entries(data.syllabus ?? {})) this.syllabusCache.set(k, v);
    const inferredCutoff = Date.now() - INFERRED_TTL_MS; // like the D1 purge
    for (const [k, v] of Object.entries(data.inferred ?? {})) {
      if (v.checkedAt >= inferredCutoff) this.inferredSchedules.set(k, v);
    }
    const maxId = Math.max(0, ...this.users.keys());
    this.nextUserId = Math.max(data.nextUserId ?? 1, maxId + 1);
  }

  private pruneActions(): void {
    const cutoff = Date.now() - FINISHED_ACTION_TTL_MS;
    for (const [id, a] of this.actions) if (a.status !== 'pending' && a.createdAt < cutoff) this.actions.delete(id);
  }

  /**
   * Snapshot to disk (tmp file + rename). The file is owned by one process: when two servers share it, the last
   * writer wins and the other one's changes are lost on its next write.
   */
  private persist(): void {
    const path = this.persistPath;
    if (!path) return;
    this.pruneActions();
    const state: PersistedState = {
      version: 1,
      nextUserId: this.nextUserId,
      users: [...this.users.values()],
      actions: [...this.actions.values()],
      syllabus: Object.fromEntries(this.syllabusCache),
      inferred: Object.fromEntries(this.inferredSchedules),
    };
    const json = JSON.stringify(state, null, 2);
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const tmp = `${path}.${process.pid}.tmp`;
        await writeFile(tmp, json, { mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, path);
      })
      .catch((e) => this.onPersistError(e));
  }

  /** Resolves when every queued write has reached the disk. */
  flush(): Promise<void> {
    return this.writeChain;
  }

  // ------------------------------------------------------------------ users

  async getUser(id: number): Promise<UserRow | null> {
    const u = this.users.get(id);
    return u ? clone(u) : null;
  }

  async getUserByMoodleId(moodleUserId: number): Promise<UserRow | null> {
    for (const u of this.users.values()) if (u.moodleUserId === moodleUserId) return clone(u);
    return null;
  }

  async upsertUser(input: { moodleUserId: number; fullname: string; lang: string }): Promise<UserRow> {
    let row = [...this.users.values()].find((u) => u.moodleUserId === input.moodleUserId);
    if (row) {
      row.fullname = input.fullname;
      row.lang = input.lang;
    } else {
      row = {
        id: this.nextUserId++,
        moodleUserId: input.moodleUserId,
        fullname: input.fullname,
        lang: input.lang,
        settings: { ...DEFAULT_SETTINGS },
        createdAt: Date.now(),
        lastSeenAt: null,
      };
      this.users.set(row.id, row);
    }
    this.persist();
    return clone(row);
  }

  async updateSettings(userId: number, settings: UserSettings): Promise<void> {
    const u = this.users.get(userId);
    if (!u) return;
    u.settings = clone(settings);
    this.persist();
  }

  async touchUser(userId: number, at: number): Promise<void> {
    const u = this.users.get(userId);
    if (u) u.lastSeenAt = at; // not persisted: changes on every run
  }

  async deleteUser(userId: number): Promise<void> {
    this.users.delete(userId);
    this.sweptAt.delete(userId);
    this.credentials.delete(userId);
    for (const rows of [this.sessions, this.apiKeys, this.actions, this.uploads, this.courseSnapshots]) {
      dropOwnedBy(rows, userId);
    }
    for (const k of this.inferredSchedules.keys()) if (k.startsWith(`${userId}:`)) this.inferredSchedules.delete(k);
    this.auditRows = this.auditRows.filter((r) => r.userId !== userId);
    this.persist();
  }

  // ------------------------------------------------------------------ credential

  async getCredential(userId: number): Promise<CredentialRow | null> {
    const c = this.credentials.get(userId);
    return c ? clone(c) : null;
  }

  async putCredential(row: CredentialRow): Promise<void> {
    this.credentials.set(row.userId, clone(row));
  }

  async updateCredentialStatus(
    userId: number,
    patch: { status?: 'active' | 'invalid'; lastOkAt?: number | null; lastError?: string | null },
  ): Promise<void> {
    const c = this.credentials.get(userId);
    if (!c) return;
    if (patch.status !== undefined) c.status = patch.status;
    if (patch.lastOkAt !== undefined) c.lastOkAt = patch.lastOkAt;
    if (patch.lastError !== undefined) c.lastError = patch.lastError;
  }

  // ------------------------------------------------------------------ sessions

  async createSession(row: SessionRow): Promise<void> {
    this.sessions.set(row.idHash, clone(row));
  }

  async getSession(idHash: string): Promise<SessionRow | null> {
    const s = this.sessions.get(idHash);
    return s ? clone(s) : null;
  }

  async touchSession(idHash: string, at: number, expiresAt: number): Promise<void> {
    const s = this.sessions.get(idHash);
    if (s) {
      s.lastSeenAt = at;
      s.expiresAt = expiresAt;
    }
  }

  async deleteSession(idHash: string): Promise<void> {
    this.sessions.delete(idHash);
  }

  async deleteUserSessions(userId: number): Promise<void> {
    for (const [k, v] of this.sessions) if (v.userId === userId) this.sessions.delete(k);
  }

  // ------------------------------------------------------------------ API keys

  async createApiKey(row: ApiKeyRow): Promise<void> {
    this.apiKeys.set(row.id, clone(row));
  }

  async listApiKeys(userId: number): Promise<ApiKeyRow[]> {
    return [...this.apiKeys.values()]
      .filter((k) => k.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(clone);
  }

  async getApiKeyByHash(keyHash: string): Promise<ApiKeyRow | null> {
    for (const k of this.apiKeys.values()) if (k.keyHash === keyHash && k.revokedAt === null) return clone(k);
    return null;
  }

  async revokeApiKey(userId: number, id: string, at: number): Promise<boolean> {
    const k = this.apiKeys.get(id);
    if (!k || k.userId !== userId || k.revokedAt !== null) return false;
    k.revokedAt = at;
    return true;
  }

  async touchApiKey(id: string, at: number): Promise<void> {
    const k = this.apiKeys.get(id);
    if (k) k.lastUsedAt = at;
  }

  // ------------------------------------------------------------------ actions

  async createAction(row: ActionRow): Promise<void> {
    this.actions.set(row.id, clone(row));
    this.persist();
  }

  async getAction(id: string): Promise<ActionRow | null> {
    const a = this.actions.get(id);
    return a ? clone(a) : null;
  }

  async claimAction(id: string, userId: number, now: number): Promise<boolean> {
    const a = this.actions.get(id);
    if (!a || a.userId !== userId || a.status !== 'pending' || a.expiresAt <= now) return false;
    a.status = 'executing'; // single-threaded: check and set cannot interleave
    this.persist();
    return true;
  }

  async updateAction(
    id: string,
    patch: Partial<Pick<ActionRow, 'status' | 'executedAt' | 'result' | 'error'>>,
  ): Promise<void> {
    const a = this.actions.get(id);
    if (!a) return;
    if (patch.status !== undefined) a.status = patch.status;
    if (patch.executedAt !== undefined) a.executedAt = patch.executedAt;
    if (patch.result !== undefined) a.result = patch.result;
    if (patch.error !== undefined) a.error = patch.error;
    this.persist();
  }

  async listActions(
    userId: number,
    opts: { status?: ActionStatus; limit: number; before?: number },
  ): Promise<ActionRow[]> {
    return [...this.actions.values()]
      .filter(
        (a) =>
          a.userId === userId &&
          (opts.status === undefined || a.status === opts.status) &&
          (opts.before === undefined || a.createdAt < opts.before),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, opts.limit)
      .map(clone);
  }

  // ------------------------------------------------------------------ upload drafts

  async createUploadDraft(row: UploadDraftRow): Promise<void> {
    this.uploads.set(row.id, clone(row));
  }

  async getUploadDraft(id: string): Promise<UploadDraftRow | null> {
    const u = this.uploads.get(id);
    return u ? clone(u) : null;
  }

  /** Expires the draft now; true only for the single caller that consumed it. */
  async consumeUploadDraft(id: string): Promise<boolean> {
    const u = this.uploads.get(id);
    const now = Date.now();
    if (!u || u.expiresAt <= now) return false;
    u.expiresAt = now;
    return true;
  }

  async appendUploadedFile(id: string, file: UploadedDraftFile): Promise<void> {
    const u = this.uploads.get(id);
    if (!u) return;
    u.files.push({ ...file });
    u.totalBytes += file.size;
  }

  // ------------------------------------------------------------------ course snapshots

  async getCourseSnapshots(userId: number): Promise<CourseSnapshotRow[]> {
    return [...this.courseSnapshots.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => a.courseId - b.courseId)
      .map(clone);
  }

  async putCourseSnapshot(row: CourseSnapshotRow): Promise<void> {
    this.courseSnapshots.set(`${row.userId}:${row.courseId}`, clone(row));
  }

  async touchCourseSnapshot(userId: number, courseId: number, checkedAt: number): Promise<void> {
    const row = this.courseSnapshots.get(`${userId}:${courseId}`);
    if (row) row.checkedAt = checkedAt;
  }

  async getSyllabusCache(idnumbers: string[]): Promise<Map<string, { json: string; fetchedAt: number }>> {
    const out = new Map<string, { json: string; fetchedAt: number }>();
    for (const id of idnumbers) {
      const hit = this.syllabusCache.get(id);
      if (hit) out.set(id, { ...hit });
    }
    return out;
  }

  async putSyllabusCache(idnumber: string, json: string, fetchedAt: number): Promise<void> {
    this.syllabusCache.set(idnumber, { json, fetchedAt });
    this.persist();
  }

  /** Same order as the D1 store: never swept first, then the least recently swept. */
  async listSweepUsers(limit: number): Promise<UserRow[]> {
    return [...this.users.values()]
      .filter((u) => this.credentials.get(u.id)?.status === 'active')
      .sort((a, b) => (this.sweptAt.get(a.id) ?? -1) - (this.sweptAt.get(b.id) ?? -1) || a.id - b.id)
      .slice(0, Math.max(1, Math.floor(limit)))
      .map(clone);
  }

  async markSwept(userId: number, at: number): Promise<void> {
    if (this.users.has(userId)) this.sweptAt.set(userId, at);
  }

  async setScopeCourseIds(userId: number, ids: readonly number[]): Promise<void> {
    const u = this.users.get(userId);
    if (u) u.scopeCourseIds = [...new Set(ids)].sort((a, b) => a - b); // no file write of its own, like touchUser
  }

  async getInferredSchedules(userId: number): Promise<Map<number, InferredSchedule>> {
    const out = new Map<number, InferredSchedule>();
    for (const [k, v] of this.inferredSchedules) {
      const [owner, courseId] = k.split(':').map(Number);
      if (owner === userId && courseId !== undefined) out.set(courseId, clone(v));
    }
    return out;
  }

  async putInferredSchedules(userId: number, schedules: ReadonlyMap<number, InferredSchedule>): Promise<void> {
    for (const [courseId, s] of schedules) this.inferredSchedules.set(`${userId}:${courseId}`, clone(s));
    this.persist();
  }

  // ------------------------------------------------------------------ audit

  async audit(row: AuditRow): Promise<void> {
    this.auditRows.push({ ...clone(row), id: this.nextAuditId++ });
    if (this.auditRows.length > MAX_AUDIT_ROWS) this.auditRows.splice(0, this.auditRows.length - MAX_AUDIT_ROWS);
  }

  async listAudit(userId: number, opts: { limit: number; before?: number }): Promise<AuditRow[]> {
    return this.auditRows
      .filter((r) => r.userId === userId && (opts.before === undefined || r.at < opts.before))
      .sort((a, b) => b.at - a.at || (b.id ?? 0) - (a.id ?? 0))
      .slice(0, opts.limit)
      .map(clone);
  }
}
