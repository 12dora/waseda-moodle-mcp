/**
 * Cross-module interfaces. Services depend ONLY on these; the Worker (D1) and the local stdio entry
 * (memory) provide implementations.
 */

import type {
  ActionKind,
  ActionStatus,
  Approval,
  ConnectVia,
  InferredSchedule,
  Scope,
  UploadedDraftFile,
  UserSettings,
} from './types';

// ------------------------------------------------------------------ Moodle client

export interface DraftUploadResult {
  itemid: number;
  filename: string;
  filesize: number;
}

export interface MoodleApi {
  readonly baseUrl: string; // https://wsdmoodle.waseda.jp
  readonly moodleUserId: number;
  /** Calls made so far in this request (budget accounting). */
  readonly callsMade: number;
  /**
   * REST call (POST form-encoded, PHP array encoding for nested params, wstoken in the body).
   * Read functions are memoised per request by (fn, params). Throws MoodleError / NeedsReconnect /
   * MoodleUnavailable / BudgetExceeded.
   */
  call<T = unknown>(fn: string, params?: Record<string, unknown>): Promise<T>;
  /** GET a Moodle file URL (pluginfile or webservice/pluginfile) with the token appended. Streams. */
  fetchFile(fileUrl: string, init?: { method?: 'GET' | 'HEAD'; range?: string }): Promise<Response>;
  /** Stream one file into the user's draft area via webservice/upload.php. itemId 0 = new draft. */
  uploadToDraft(
    file: { name: string; body: ReadableStream<Uint8Array> | Uint8Array; size: number; mime?: string | null },
    itemId: number,
  ): Promise<DraftUploadResult>;
}

// ------------------------------------------------------------------ persistence rows

export interface UserRow {
  id: number;
  moodleUserId: number;
  fullname: string;
  lang: string;
  settings: UserSettings;
  createdAt: number; // unix ms
  lastSeenAt: number | null;
  /** Course ids of the last interactive scope (set by listSweepUsers only), so the cron can sweep them too. */
  scopeCourseIds?: number[];
}

export interface CredentialRow {
  userId: number;
  tokenEnc: string; // AES-GCM, base64url (iv||ciphertext)
  privateTokenEnc: string | null;
  tokenHash: string; // sha256 hex of the token; detects "same token" on reconnect
  tokenHint: string; // last 4 chars
  status: 'active' | 'invalid';
  connectedVia: ConnectVia;
  connectedAt: number;
  lastOkAt: number | null;
  lastError: string | null;
}

export interface SessionRow {
  idHash: string; // sha256 hex of the cookie value
  userId: number;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  userAgent: string | null;
}

export interface ApiKeyRow {
  id: string; // "key_<rand>"
  userId: number;
  name: string;
  prefix: string; // first 8 chars of the secret ("wmm_ab12"), display only
  keyHash: string; // sha256 hex of the full secret
  scopes: Scope[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface ActionRow {
  id: string; // "act_<rand>"
  userId: number;
  kind: ActionKind;
  status: ActionStatus;
  approval: Approval;
  title: string;
  details: string[];
  warnings: string[];
  payload: Record<string, unknown>; // kind-specific execution data (see services/actions.ts)
  source: string;
  createdAt: number;
  expiresAt: number;
  executedAt: number | null;
  result: string | null;
  error: string | null;
}

export interface UploadDraftRow {
  id: string; // "upl_<rand>"
  userId: number;
  cmid: number;
  draftItemId: number;
  files: UploadedDraftFile[];
  totalBytes: number;
  createdAt: number;
  expiresAt: number;
}

export interface CourseSnapshotRow {
  userId: number;
  courseId: number;
  json: string; // compact CourseSnapshot JSON (services/sweep)
  fetchedAt: number; // last full core_course_get_contents
  checkedAt: number; // last update check (core_course_get_updates_since) or fetch
}

export interface AuditRow {
  id?: number;
  userId: number;
  at: number;
  actor: string; // "mcp:<source>" | "console" | "extension" | "system"
  action: string; // e.g. "connect", "tool:get_due_items", "action:execute", "apikey:create"
  detail: Record<string, unknown> | null; // never tokens or file bytes
}

/** A user's secret calendar feed (§17.2); the token itself is never stored, only its SHA-256. */
export interface CalendarFeedInfo {
  userId: number;
  createdAt: number;
  lastFetchAt: number | null;
  cacheAt: number | null; // when cacheIcs was rendered
}

export interface CalendarFeedRow extends CalendarFeedInfo {
  cacheIcs: string | null;
}

export interface Store {
  // users
  getUser(id: number): Promise<UserRow | null>;
  getUserByMoodleId(moodleUserId: number): Promise<UserRow | null>;
  /** Insert or update fullname/lang; returns the row. */
  upsertUser(input: { moodleUserId: number; fullname: string; lang: string }): Promise<UserRow>;
  updateSettings(userId: number, settings: UserSettings): Promise<void>;
  touchUser(userId: number, at: number): Promise<void>;
  /** Deletes the user and every dependent row (credentials, sessions, keys, actions, uploads, index, audit). */
  deleteUser(userId: number): Promise<void>;

  // Moodle credential (one per user)
  getCredential(userId: number): Promise<CredentialRow | null>;
  putCredential(row: CredentialRow): Promise<void>;
  updateCredentialStatus(
    userId: number,
    patch: { status?: 'active' | 'invalid'; lastOkAt?: number | null; lastError?: string | null },
  ): Promise<void>;

  // console sessions
  createSession(row: SessionRow): Promise<void>;
  getSession(idHash: string): Promise<SessionRow | null>;
  touchSession(idHash: string, at: number, expiresAt: number): Promise<void>;
  deleteSession(idHash: string): Promise<void>;
  deleteUserSessions(userId: number): Promise<void>;

  // API keys
  createApiKey(row: ApiKeyRow): Promise<void>;
  listApiKeys(userId: number): Promise<ApiKeyRow[]>; // newest first, includes revoked
  getApiKeyByHash(keyHash: string): Promise<ApiKeyRow | null>;
  revokeApiKey(userId: number, id: string, at: number): Promise<boolean>;
  touchApiKey(id: string, at: number): Promise<void>;

  // write actions
  createAction(row: ActionRow): Promise<void>;
  getAction(id: string): Promise<ActionRow | null>;
  /**
   * Atomically move a pending, unexpired action owned by userId to 'executing'. Returns true only for the single
   * caller that won the claim (D1: UPDATE … WHERE status='pending' AND expires_at > now, changes === 1).
   */
  claimAction(id: string, userId: number, now: number): Promise<boolean>;
  updateAction(
    id: string,
    patch: Partial<Pick<ActionRow, 'status' | 'executedAt' | 'result' | 'error'>>,
  ): Promise<void>;
  listActions(userId: number, opts: { status?: ActionStatus; limit: number; before?: number }): Promise<ActionRow[]>;

  // upload drafts (signed upload links)
  createUploadDraft(row: UploadDraftRow): Promise<void>;
  getUploadDraft(id: string): Promise<UploadDraftRow | null>;
  appendUploadedFile(id: string, file: UploadedDraftFile): Promise<void>;
  /**
   * Atomically retire an upload link (expires_at = now) so no further file can reach its draft. Returns true only for
   * the single caller that consumed a still-valid draft.
   */
  consumeUploadDraft(id: string): Promise<boolean>;

  // course content snapshots (sweep + search)
  getCourseSnapshots(userId: number): Promise<CourseSnapshotRow[]>;
  putCourseSnapshot(row: CourseSnapshotRow): Promise<void>;
  touchCourseSnapshot(userId: number, courseId: number, checkedAt: number): Promise<void>;
  // public syllabus cache (global, keyed by Moodle course idnumber; json = SyllabusInfo or "null" for "no syllabus")
  getSyllabusCache(idnumbers: string[]): Promise<Map<string, { json: string; fetchedAt: number }>>;
  putSyllabusCache(idnumber: string, json: string, fetchedAt: number): Promise<void>;
  /** Users with an active credential, for the scheduled sweep (never swept first, then least recently swept). */
  listSweepUsers(limit: number): Promise<UserRow[]>;
  /** Stamps the user's last scheduled-sweep attempt (also after a failure or with an empty scope). */
  markSwept(userId: number, at: number): Promise<void>;
  /** Remembers the course ids an interactive call resolved as the scope; writes only when the list changed. */
  setScopeCourseIds(userId: number, ids: readonly number[]): Promise<void>;
  // class times inferred from Moodle attendance sessions (per user; an entry with no slots means "looked, found none")
  getInferredSchedules(userId: number): Promise<Map<number, InferredSchedule>>;
  putInferredSchedules(userId: number, schedules: ReadonlyMap<number, InferredSchedule>): Promise<void>;

  // secret ICS calendar feed (Worker only; the local entry throws)
  getCalendarFeed(userId: number): Promise<CalendarFeedInfo | null>;
  /** By the SHA-256 of the URL token; includes the cached feed. null = unknown or revoked. */
  getCalendarFeedByHash(tokenHash: string): Promise<CalendarFeedRow | null>;
  /** Creates the user's feed or rotates its token (the old URL stops working; fetch time and cache are reset). */
  replaceCalendarFeed(userId: number, feed: { tokenHash: string; createdAt: number }): Promise<void>;
  /** Revokes the feed; false when the user had none. */
  deleteCalendarFeed(userId: number): Promise<boolean>;
  /** Stamps a fetch; with `ics` it also replaces the cached feed (cacheAt = at). */
  recordCalendarFetch(userId: number, fetch: { at: number; ics?: string }): Promise<void>;

  // audit log
  audit(row: AuditRow): Promise<void>;
  listAudit(userId: number, opts: { limit: number; before?: number }): Promise<AuditRow[]>;
}

// ------------------------------------------------------------------ signing / crypto

export interface Signer {
  /** HMAC-signed, url-safe ticket "<b64url(json)>.<b64url(sig)>" with an `exp` (unix sec) inside. */
  sign(payload: Record<string, unknown>, ttlSec: number): Promise<string>;
  /** Returns the payload or null when malformed, tampered or expired. */
  verify<T extends Record<string, unknown>>(ticket: string): Promise<T | null>;
}

// ------------------------------------------------------------------ per-request service context

/** Aggregate usage counters, Worker `/mcp` requests only (stdio and the console never set it). Fire-and-forget. */
export interface UsageRecorder {
  toolCall(tool: string, ok: boolean): void;
}

export interface ServiceContext {
  user: UserRow;
  store: Store;
  signer: Signer;
  /** Lazily decrypts the stored token and builds a budgeted client. Throws NeedsReconnect. */
  moodle(): Promise<MoodleApi>;
  publicUrl: string; // e.g. https://wasemoodle.example.com (no trailing slash); '' in stdio mode
  mode: 'worker' | 'stdio';
  scopes: Scope[];
  /** Public syllabus term lookup (WMM / SYLLABUS_LOOKUP kill switch); undefined = on. */
  syllabusLookup?: boolean;
  source: string; // display label of the caller: OAuth client name, "API key: <name>", "Console", "Local"
  /** Counts MCP tool calls in the operator statistics; undefined = not counted. */
  usage?: UsageRecorder;
  /** Defer work past the response (Workers ctx.waitUntil; stdio runs it immediately). */
  defer(p: Promise<unknown>): void;
}
