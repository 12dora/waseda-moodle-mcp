/** Domain types come from the server core; console-only response shapes are declared here (contract §5). */

export type {
  ActionRecord,
  ActionResult,
  ActionStatus,
  Course,
  DayNote,
  DueItem,
  DueList,
  PeriodTime,
  ScheduleOverride,
  Scope,
  Timetable,
  TimetableClass,
  TimetableCourseRef,
  TimetableDay,
  TimetableUnknown,
  TimetableUnscheduled,
  UiLang,
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

export interface Me {
  user: UserInfo;
  /** null when the stored Moodle credential is gone (reconnect required). */
  credential: CredentialInfo | null;
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
