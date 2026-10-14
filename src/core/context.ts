/**
 * Cross-module interfaces. Services depend ONLY on these; the Worker (D1) and the local stdio entry
 * (memory) provide implementations.
 */

import type {
  ActionKind,
  ActionStatus,
  Approval,
  ConnectVia,
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

export interface CourseIndexRow {
  userId: number;
  courseId: number;
  json: string; // compact JSON of CourseOutline (see services/courses.ts)
  updatedAt: number;
}

export interface AuditRow {
  id?: number;
  userId: number;
  at: number;
  actor: string; // "mcp:<source>" | "console" | "extension" | "system"
  action: string; // e.g. "connect", "tool:get_due_items", "action:execute", "apikey:create"
  detail: Record<string, unknown> | null; // never tokens or file bytes
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
  updateAction(
    id: string,
    patch: Partial<Pick<ActionRow, 'status' | 'executedAt' | 'result' | 'error'>>,
  ): Promise<void>;
  listActions(userId: number, opts: { status?: ActionStatus; limit: number; before?: number }): Promise<ActionRow[]>;

  // upload drafts (signed upload links)
  createUploadDraft(row: UploadDraftRow): Promise<void>;
  getUploadDraft(id: string): Promise<UploadDraftRow | null>;
  appendUploadedFile(id: string, file: UploadedDraftFile): Promise<void>;

  // course outline cache for search
  getCourseIndex(userId: number): Promise<CourseIndexRow[]>;
  putCourseIndex(row: CourseIndexRow): Promise<void>;

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

export interface ServiceContext {
  user: UserRow;
  store: Store;
  signer: Signer;
  /** Lazily decrypts the stored token and builds a budgeted client. Throws NeedsReconnect. */
  moodle(): Promise<MoodleApi>;
  publicUrl: string; // e.g. https://wasemoodle.example.com (no trailing slash); '' in stdio mode
  mode: 'worker' | 'stdio';
  scopes: Scope[];
  source: string; // display label of the caller: OAuth client name, "API key: <name>", "Console", "Local"
  /** Defer work past the response (Workers ctx.waitUntil; stdio runs it immediately). */
  defer(p: Promise<unknown>): void;
}
