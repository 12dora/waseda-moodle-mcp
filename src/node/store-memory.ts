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
  CourseIndexRow,
  CredentialRow,
  SessionRow,
  Store,
  UploadDraftRow,
  UserRow,
} from '../core/context';
import { type ActionStatus, DEFAULT_SETTINGS, type UploadedDraftFile, type UserSettings } from '../core/types';

const MAX_AUDIT_ROWS = 1000;

interface PersistedState {
  version: 1;
  nextUserId: number;
  users: UserRow[];
  actions: ActionRow[];
}

interface MemoryStoreOptions {
  /** JSON file for users (settings) and actions; created with mode 0600. Omit for a purely in-memory store. */
  persistPath?: string;
  /** Called when reading or writing the persistence file fails (default: ignore). */
  onPersistError?: (error: unknown) => void;
}

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  private readonly users = new Map<number, UserRow>();
  private readonly credentials = new Map<number, CredentialRow>();
  private readonly sessions = new Map<string, SessionRow>();
  private readonly apiKeys = new Map<string, ApiKeyRow>();
  private readonly actions = new Map<string, ActionRow>();
  private readonly uploads = new Map<string, UploadDraftRow>();
  private readonly courseIndex = new Map<string, CourseIndexRow>();
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
      const data = JSON.parse(raw) as Partial<PersistedState>;
      for (const u of data.users ?? []) {
        this.users.set(u.id, { ...u, settings: { ...DEFAULT_SETTINGS, ...u.settings } });
      }
      for (const a of data.actions ?? []) this.actions.set(a.id, a);
      const maxId = Math.max(0, ...this.users.keys());
      this.nextUserId = Math.max(data.nextUserId ?? 1, maxId + 1);
    } catch (e) {
      this.onPersistError(e);
    }
  }

  private persist(): void {
    const path = this.persistPath;
    if (!path) return;
    const state: PersistedState = {
      version: 1,
      nextUserId: this.nextUserId,
      users: [...this.users.values()],
      actions: [...this.actions.values()],
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
        settings: { ...DEFAULT_SETTINGS, hiddenCourseIds: [] },
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
    this.credentials.delete(userId);
    for (const [k, v] of this.sessions) if (v.userId === userId) this.sessions.delete(k);
    for (const [k, v] of this.apiKeys) if (v.userId === userId) this.apiKeys.delete(k);
    for (const [k, v] of this.actions) if (v.userId === userId) this.actions.delete(k);
    for (const [k, v] of this.uploads) if (v.userId === userId) this.uploads.delete(k);
    for (const [k, v] of this.courseIndex) if (v.userId === userId) this.courseIndex.delete(k);
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

  async appendUploadedFile(id: string, file: UploadedDraftFile): Promise<void> {
    const u = this.uploads.get(id);
    if (!u) return;
    u.files.push({ ...file });
    u.totalBytes += file.size;
  }

  // ------------------------------------------------------------------ course index

  async getCourseIndex(userId: number): Promise<CourseIndexRow[]> {
    return [...this.courseIndex.values()].filter((r) => r.userId === userId).map(clone);
  }

  async putCourseIndex(row: CourseIndexRow): Promise<void> {
    this.courseIndex.set(`${row.userId}:${row.courseId}`, clone(row));
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
