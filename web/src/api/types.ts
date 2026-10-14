/** Domain types come from the server core; console-only response shapes are declared here (contract §5). */

export type {
  ActionRecord,
  ActionResult,
  ActionStatus,
  Course,
  DueItem,
  DueList,
  Scope,
  UiLang,
  UserSettings,
  WriteMode,
} from '../../../src/core/types';

import type {
  Course,
  CourseUpdate,
  CredentialInfo,
  IsoJst,
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

export interface TimetableClass {
  courseId: number;
  courseName: string;
  start: string; // 'HH:MM'
  end: string;
  periods: string;
  classroom: string | null;
  campus: string | null;
  url: string;
}

export interface TimetableDay {
  date: string; // 'YYYY-MM-DD'
  weekday: number | string;
  note: string | null; // e.g. 振替: 月曜授業 / 休講日
  classes: TimetableClass[];
}

export interface TimetableCourseRef {
  courseId: number;
  courseName: string;
  url: string;
}

export interface TimetableResponse {
  days: TimetableDay[];
  onDemand: TimetableCourseRef[];
  unknown: TimetableCourseRef[];
}

export type SettingsPatch = Partial<UserSettings>;
