/** `GET /api/admin/stats` response: aggregate counts only (operator). Built by the Worker, shown by the console. */

import type { ActionKind } from './types';
import type { FailureClass, LatencyBucket } from './usage';

export type { FailureClass, LatencyBucket } from './usage';

/** Distinct active users per channel; `total` counts a person using both once. */
export interface ChannelUsers {
  mcp: number;
  web: number;
  total: number;
}

export interface ToolStats {
  name: string;
  calls: number;
  errors: number;
  failures: Record<FailureClass, number>;
  latency: Record<LatencyBucket, number>;
}

export interface DayStats {
  day: string;
  /** MCP active users (unchanged meaning). */
  active: number;
  activeWeb: number;
  activeAll: number;
  calls: number;
  errors: number;
  newUsers: number;
  webRequests: number;
  icsFetches: number;
  icsFeeds: number;
  renewed: number;
  renewKept: number;
  renewFailed: number;
  connects: number;
}

export interface ActionFunnel {
  kind: ActionKind;
  prepared: number;
  executed: number;
  failed: number;
  cancelled: number;
  expired: number;
}

export interface Cohort {
  /** Mondays (JST) of the first and the last signup week of the group. */
  from: string;
  to: string;
  /** Signups of the group (at least 3), counted when each account was created. */
  users: number;
  /** Of them, active again 1, 2 and 4 weeks after their signup week; null = not yet reached for every week. */
  w1: number | null;
  w2: number | null;
  w4: number | null;
}

/** Days are JST, oldest -> newest. */
export interface UsageStats {
  generatedAt: number;
  days: number;
  /** `active*` count AI-client users only; use `channels` for the overall number. */
  users: { total: number; newInRange: number; activeToday: number; activeWeek: number; activeMonth: number };
  daily: DayStats[];
  tools: ToolStats[];
  clients: { name: string; calls: number; activeMonth: number }[];
  channels: { today: ChannelUsers; week: ChannelUsers; month: ChannelUsers };
  pages: { name: string; requests: number }[];
  /** Calls per JST hour 0–23 over the range. */
  hours: { mcp: number[]; web: number[] };
  credentials: {
    /** Live snapshot at report time. */
    active: number;
    invalid: number;
    autoRenew: number;
    /** Range totals. */
    renewed: number;
    kept: number;
    failed: number;
    failures: { reason: string; count: number }[];
    connects: { via: string; count: number }[];
  };
  actions: ActionFunnel[];
  /** Signup-week groups, oldest first. */
  retention: Cohort[];
}
