/** Domain types come from the server core; console-only response shapes are declared here (contract §5). */

export type {
  ActionRecord,
  ActionResult,
  ActionStatus,
  Course,
  CourseOverview,
  CourseOverviewItem,
  CourseSchedule,
  CourseSlot,
  CourseUpdate,
  CredentialInfo,
  DayNote,
  DueItem,
  DueList,
  FailureClass,
  GradingRow,
  LatencyBucket,
  PeriodTime,
  ScheduleOverride,
  Scope,
  SyllabusSummary,
  Timetable,
  TimetableClass,
  TimetableCourseRef,
  TimetableDay,
  TimetableUnknown,
  TimetableUnscheduled,
  UiLang,
  UsageStats,
  UserSettings,
  WriteMode,
} from '../../../src/core/types';

import type {
  Course,
  CourseUpdate,
  CredentialInfo,
  DueList,
  IsoJst,
  ScheduleOverride,
  Scope,
  UserInfo,
  UserSettings,
} from '../../../src/core/types';

export interface AppConfig {
  publicUrl: string;
  mcpUrl: string;
  moodleUrl: string;
  launchUrl: string;
  registration: 'open' | 'allowlist';
  extensionUrl: string | null;
  version: string;
}

/** The user's standing with the operator's approval for mail (operators are always `approved`). */
export type MailAccess = 'none' | 'pending' | 'approved' | 'rejected';

/** GET /api/me `mail`: the Waseda mailbox connection. `null` = this server does not offer mail. */
export interface MailInfo {
  connection: MailConnection | null;
  access: MailAccess;
  /** Operators only: requests waiting for a decision. */
  pendingRequests?: number;
  /** Free slots left; null = unlimited. */
  slotsLeft: number | null;
  /** This user already holds a slot (reconnecting never needs a free one). */
  hasSlot: boolean;
  /** Auto-disconnect after this many days without use; null = never. */
  idleDays: number | null;
}

export interface MailConnection {
  address: string;
  canSend: boolean;
  status: 'active' | 'invalid';
  /** Epoch milliseconds. */
  connectedAt: number;
  lastUsedAt: number | null;
  endReason: 'idle' | 'revoked' | null;
}

export type MailRequestStatus = Exclude<MailAccess, 'none'>;
export type MailRequestAction = 'approve' | 'reject' | 'revoke';

/** One row of the operator's mail request list. Times are epoch milliseconds. */
export interface MailRequest {
  userId: number;
  fullname: string;
  moodleUserId: number;
  status: MailRequestStatus;
  requestedAt: number;
  decidedAt: number | null;
  connection: { address: string; status: MailConnection['status'] } | null;
}

export interface MailRequestList {
  requests: MailRequest[];
  /** Mail slots used so far; `limit` null = unlimited. */
  slots: { used: number; limit: number | null };
}

export interface Me {
  user: UserInfo;
  /** null when the stored Moodle credential is gone (reconnect required). */
  credential: CredentialInfo | null;
  /** Operator of this instance (sees the usage page). Older servers omit it. */
  isAdmin?: boolean;
  /** Older servers omit it; null = mail is not offered (hide the Mail tab). */
  mail?: MailInfo | null;
}

export interface ConnectResult extends Me {
  created: boolean;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  createdAt: IsoJst;
  lastUsedAt: IsoJst | null;
  revokedAt: IsoJst | null;
}

export interface AppGrant {
  id: string;
  clientId: string;
  clientName: string;
  scopes: Scope[];
  createdAt: IsoJst;
}

export interface AuditEntry {
  id: number;
  at: IsoJst;
  actor: string;
  action: string;
  detail: string | null;
}

export interface OAuthRequestInfo {
  clientName: string;
  clientUri: string | null;
  clientDomain: string | null;
  verified: boolean;
  redirectHost: string;
  scopes: Scope[];
}

/**
 * POST /api/connect body: a hand-off code, or the pasted MoodleSession cookie or launch link. `switchAccount`
 * confirms replacing the signed-in account (the server answers account_switch first).
 */
export type ConnectRequest =
  | { code: string; switchAccount?: boolean }
  | { session: string; via: 'paste'; switchAccount?: boolean }
  | { launch: string; via: 'paste'; passport?: string; switchAccount?: boolean };

/**
 * GET /api/due: the due list as computed at `cachedAt`. `stale`: the server answered its stored copy at once; ask again
 * with refresh for the current list.
 */
export interface ConsoleDueList extends DueList {
  cachedAt: IsoJst;
  stale: boolean;
}

export interface CoursesResponse {
  mode: 'mine' | 'auto';
  courses: Course[];
}

export interface UpdatesResponse {
  updates: CourseUpdate[];
  stats: { checked: number; stale: number; checkedAt: IsoJst | null };
}

/** PATCH /api/settings body: `scheduleOverrides` merges per course, `null` removes that course's entry (§15.4). */
export type SettingsPatch = Partial<Omit<UserSettings, 'scheduleOverrides'>> & {
  scheduleOverrides?: Record<string, ScheduleOverride | null>;
};

/** GET /api/calendar (§17.2). The feed URL itself is only returned by POST, once. */
export interface CalendarStatus {
  enabled: boolean;
  createdAt: IsoJst | null;
  lastFetchAt: IsoJst | null;
}
