import { api } from './client';
import type {
  ActionRecord,
  ActionResult,
  ActionStatus,
  ApiKey,
  AppConfig,
  AppGrant,
  AuditEntry,
  CalendarStatus,
  ConnectRequest,
  ConnectResult,
  CourseOverview,
  CoursesResponse,
  DueList,
  Me,
  OAuthRequestInfo,
  Scope,
  SettingsPatch,
  SyllabusSummary,
  Timetable,
  UpdatesResponse,
  UsageStats,
  UserSettings,
} from './types';

const id = encodeURIComponent;

export const getConfig = () => api.get<AppConfig>('/api/config', { redirectOn401: false });

export const connect = (body: ConnectRequest) =>
  api.post<ConnectResult>('/api/connect', body, { redirectOn401: false });

export const getMe = (redirectOn401 = true) => api.get<Me>('/api/me', { redirectOn401 });
export const logout = () => api.post<unknown>('/api/logout');
export const deleteAccount = () => api.del<unknown>('/api/me');

export const patchSettings = (patch: SettingsPatch) => api.patch<{ settings: UserSettings }>('/api/settings', patch);

export const getDue = (days = 14) => api.get<DueList>('/api/due', { query: { days } });
export const getCourses = () => api.get<CoursesResponse>('/api/courses');
export const getTimetable = (date: string, days: number) =>
  api.get<Timetable>('/api/timetable', { query: { date, days } });
export const getUpdates = (days = 7, courseId?: number) =>
  api.get<UpdatesResponse>('/api/updates', { query: { days, course_id: courseId } });
export const getCourseOverview = () => api.get<CourseOverview>('/api/courses/overview');
export const getSyllabusSummary = (courseId: number) =>
  api.get<SyllabusSummary>('/api/syllabus', { query: { course_id: courseId } });

export const listKeys = () => api.get<ApiKey[]>('/api/keys');
export const createKey = (name: string, scopes: Scope[]) =>
  api.post<{ key: ApiKey; secret: string }>('/api/keys', { name, scopes });
export const revokeKey = (keyId: string) => api.del<unknown>(`/api/keys/${id(keyId)}`);

export const getCalendar = () => api.get<CalendarStatus>('/api/calendar');
/** Creates the feed or rotates its secret; the returned URL is shown once. */
export const createCalendar = () => api.post<{ url: string }>('/api/calendar');
export const deleteCalendar = () => api.del<unknown>('/api/calendar');

export const listApps = () => api.get<AppGrant[]>('/api/apps');
export const revokeApp = (grantId: string) => api.del<unknown>(`/api/apps/${id(grantId)}`);

export const listActions = (status?: ActionStatus, limit?: number) =>
  api.get<ActionRecord[]>('/api/actions', { query: { status, limit } });
export const approveAction = (actionId: string) => api.post<ActionResult>(`/api/actions/${id(actionId)}/approve`);
export const cancelAction = (actionId: string) => api.post<unknown>(`/api/actions/${id(actionId)}/cancel`);

export const listActivity = (limit = 50, before?: number) =>
  api.get<AuditEntry[]>('/api/activity', { query: { limit, before } });

export const getOAuthRequest = (reqId: string) =>
  api.get<OAuthRequestInfo>(`/api/oauth/requests/${id(reqId)}`, { redirectOn401: false });
export const approveOAuth = (reqId: string, scopes: Scope[]) =>
  api.post<{ redirectTo: string }>(`/api/oauth/requests/${id(reqId)}/approve`, { scopes }, { redirectOn401: false });
export const denyOAuth = (reqId: string) =>
  api.post<{ redirectTo: string }>(`/api/oauth/requests/${id(reqId)}/deny`, {}, { redirectOn401: false });

export const getUsageStats = (days: 7 | 30 | 90) => api.get<UsageStats>('/api/admin/stats', { query: { days } });
