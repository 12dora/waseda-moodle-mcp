/**
 * In-memory Store for the local single-user (stdio) entry.
 * Settings and write actions can be persisted to a JSON file so pending previews and preferences survive
 * restarts; credentials, sessions, API keys, uploads and the audit log stay in memory only.
 */

import type {
  ActionRow,
  ApiKeyRow,
  AuditRow,
  CourseSnapshotRow,
  CredentialExpect,
  CredentialPatch,
  CredentialRow,
  RenewalCandidate,
  SessionRow,
  Store,
  UploadDraftRow,
  UserRow,
} from '../core/context';
import { blocksClaim, SUPERSEDED_RESULT, supersedableIds } from '../core/services/actions/target';
import {
  ACTION_STATUS_FROM,
  type ActionStatus,
  DEFAULT_SETTINGS,
  type InferredSchedule,
  type UploadedDraftFile,
  type UserSettings,
} from '../core/types';
import { type PersistedState, restoredSettings, StateFile } from './state-file';

const MAX_AUDIT_ROWS = 1000;
/** Finished actions (any status but pending) are dropped from the state file after this long. */
const FINISHED_ACTION_TTL_MS = 30 * 24 * 3600 * 1000;
/** Inferred class times are dropped after this long without a check (the D1 store purges them the same way). */
const INFERRED_TTL_MS = 30 * 24 * 3600 * 1000;

interface MemoryStoreOptions {
  /** JSON file for users (settings), actions and lookup caches; mode 0600. Omit for a purely in-memory store. */
  persistPath?: string;
  /** Called when reading or writing the persistence file fails (default: ignore). */
  onPersistError?: (error: unknown) => void;
}

const clone = <T>(v: T): T => structuredClone(v);

const localOnly = async (): Promise<never> => {
  throw new Error('Calendar feeds are not available in local mode.');
};

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
  private readonly file: StateFile | undefined;

  constructor(opts: MemoryStoreOptions = {}) {
    if (opts.persistPath) {
      this.file = new StateFile(opts.persistPath, opts.onPersistError ?? (() => undefined));
      this.file.load((data) => this.restore(data));
    }
  }

  // ------------------------------------------------------------------ persistence

  private restore(data: Partial<PersistedState>): void {
    for (const u of data.users ?? []) this.users.set(u.id, { ...u, settings: restoredSettings(u.settings) });
    // files written before targets existed lack the field
    for (const a of data.actions ?? []) this.actions.set(a.id, { ...a, target: a.target ?? null });
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

  /** Snapshot to the state file (see StateFile). */
  private persist(): void {
    if (!this.file) return;
    this.pruneActions();
    this.file.write({
      version: 1,
      nextUserId: this.nextUserId,
      users: [...this.users.values()],
      actions: [...this.actions.values()],
      syllabus: Object.fromEntries(this.syllabusCache),
      inferred: Object.fromEntries(this.inferredSchedules),
    });
  }

  /** Resolves when every queued write has reached the disk. */
  flush(): Promise<void> {
    return this.file?.flush() ?? Promise.resolve();
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

  /** Like the D1 store: the web-session fields of an existing row are kept. */
  async putCredential(row: CredentialRow): Promise<void> {
    const prev = this.credentials.get(row.userId);
    this.credentials.set(row.userId, {
      ...clone(row),
      sessionEnc: prev?.sessionEnc ?? null,
      sessionOkAt: prev?.sessionOkAt ?? null,
      sessionTriedAt: prev?.sessionTriedAt ?? null,
      renewedAt: prev?.renewedAt ?? null,
      autologinAt: prev?.autologinAt ?? null,
    });
  }

  async updateCredentialStatus(userId: number, patch: CredentialPatch): Promise<void> {
    const c = this.credentials.get(userId);
    if (!c) return;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) Object.assign(c, { [k]: v });
  }

  async updateCredentialIf(userId: number, expect: CredentialExpect, patch: CredentialPatch): Promise<boolean> {
    const c = this.credentials.get(userId);
    const matches =
      c !== undefined &&
      c.tokenHash === expect.tokenHash &&
      (expect.sessionEnc === undefined || (c.sessionEnc ?? null) === expect.sessionEnc) &&
      (expect.autologinAt === undefined || (c.autologinAt ?? null) === expect.autologinAt);
    if (matches) await this.updateCredentialStatus(userId, patch);
    return matches;
  }

  /** Same filter and order as the D1 store. */
  async listRenewalCandidates(opts: Parameters<Store['listRenewalCandidates']>[0]): Promise<RenewalCandidate[]> {
    const visited = (c: CredentialRow) => Math.max(c.sessionOkAt ?? 0, c.sessionTriedAt ?? 0);
    const due = (c: CredentialRow) => {
      if (c.sessionEnc) return visited(c) <= opts.sessionBefore;
      const tried = c.autologinAt ?? null;
      const retry = tried === null || tried <= opts.autologinBefore || tried < c.connectedAt;
      return c.status === 'active' && c.privateTokenEnc !== null && retry;
    };
    const must = (c: CredentialRow) =>
      c.sessionEnc && visited(c) > opts.mustVisit.after && visited(c) <= opts.mustVisit.until ? 0 : 1;
    const urgency = (c: CredentialRow) =>
      c.sessionEnc ? visited(c) + opts.sessionIdleMs : (c.autologinAt ?? 0) + opts.autologinRetryMs;
    return [...this.credentials.values()]
      .filter(due)
      .sort((a, b) => must(a) - must(b) || urgency(a) - urgency(b) || a.userId - b.userId)
      .slice(0, Math.max(1, Math.floor(opts.limit)))
      .flatMap((c) => {
        const u = this.users.get(c.userId);
        return u ? [{ user: clone(u), credential: clone(c) }] : [];
      });
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
    for (const s of this.actions.values()) if (blocksClaim(s, a, now)) return false;
    a.status = 'executing'; // single-threaded: check and set cannot interleave
    this.persist();
    return true;
  }

  async supersedeActions(userId: number, target: string, now: number): Promise<string[]> {
    const ids = supersedableIds(this.actions.values(), userId, target, now);
    for (const id of ids) {
      const a = this.actions.get(id);
      if (a) Object.assign(a, { status: 'superseded', result: SUPERSEDED_RESULT });
    }
    if (ids.length) this.persist();
    return ids;
  }

  async updateAction(
    id: string,
    patch: Partial<Pick<ActionRow, 'status' | 'executedAt' | 'result' | 'error'>>,
  ): Promise<boolean> {
    const a = this.actions.get(id);
    if (!a || (patch.status !== undefined && a.status !== ACTION_STATUS_FROM[patch.status])) return false;
    if (patch.status !== undefined) a.status = patch.status;
    if (patch.executedAt !== undefined) a.executedAt = patch.executedAt;
    if (patch.result !== undefined) a.result = patch.result;
    if (patch.error !== undefined) a.error = patch.error;
    this.persist();
    return true;
  }

  async listActions(
    userId: number,
    opts: { status?: ActionStatus; target?: string; limit: number; before?: number },
  ): Promise<ActionRow[]> {
    return [...this.actions.values()]
      .filter(
        (a) =>
          a.userId === userId &&
          (opts.status === undefined || a.status === opts.status) &&
          (opts.target === undefined || a.target === opts.target) &&
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

  // secret calendar feeds are a Worker feature
  readonly getCalendarFeed = localOnly;
  readonly getCalendarFeedByHash = localOnly;
  readonly replaceCalendarFeed = localOnly;
  readonly deleteCalendarFeed = localOnly;
  readonly recordCalendarFetch = localOnly;

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
