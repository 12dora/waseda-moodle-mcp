/** D1 implementation of the core Store, assembled from per-table-group modules (src/worker/store/*). */

import type { Store } from '../core/context';
import { actionMethods, uploadMethods } from './store/actions';
import { calendarMethods } from './store/calendar';
import { type EphemeralMethods, ephemeralMethods } from './store/ephemeral';
import { type HandoffMethods, handoffMethods } from './store/handoffs';
import { inferredMethods } from './store/inferred';
import { logMethods, purgeExpired } from './store/logs';
import { mailMethods } from './store/mail';
import { mailAccessMethods } from './store/mail-access';
import { apiKeyMethods, sessionMethods } from './store/sessions';
import { type SiteMethods, siteMethods } from './store/site';
import { snapshotMethods } from './store/snapshots';
import { type UsageMethods, usageMethods } from './store/usage';
import { type UsageReportMethods, usageReportMethods } from './store/usage-report';
import { userMethods } from './store/users';

type SessionMethods = ReturnType<typeof sessionMethods>;

/**
 * The core Store plus the Worker-only extras (single-query session lookup, hand-off codes, pending OAuth requests, rate
 * limits, usage counters, site state, retention sweep).
 */
export interface D1Store
  extends Store,
    HandoffMethods,
    EphemeralMethods,
    UsageMethods,
    UsageReportMethods,
    SiteMethods {
  getSessionWithUser: SessionMethods['getSessionWithUser'];
  purgeExpired(now: number): Promise<Record<string, number>>;
}

export function createD1Store(db: D1Database): D1Store {
  return {
    ...userMethods(db),
    ...sessionMethods(db),
    ...apiKeyMethods(db),
    ...actionMethods(db),
    ...uploadMethods(db),
    ...snapshotMethods(db),
    ...inferredMethods(db),
    ...calendarMethods(db),
    ...mailMethods(db),
    ...mailAccessMethods(db),
    ...logMethods(db),
    ...handoffMethods(db),
    ...ephemeralMethods(db),
    ...usageMethods(db),
    ...usageReportMethods(db),
    ...siteMethods(db),
    purgeExpired: (now) => purgeExpired(db, now),
  };
}
