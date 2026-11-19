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

/** GET /api/me `mail`: the Waseda mailbox connection. `null` = this server does not offer mail. */
export interface MailInfo {
  connection: MailConnection | null;
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

/** POST /api/connect body (§11): a handoff code, or a pasted launch link. */
export type ConnectRequest =
  | { code: string; switchAccount?: boolean }
  | { launch: string; via: 'paste'; passport?: string };

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
