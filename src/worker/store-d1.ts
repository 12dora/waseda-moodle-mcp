/** D1 implementation of the core Store, assembled from per-table-group modules (src/worker/store/*). */

import type { Store } from '../core/context';
import { actionMethods, uploadMethods } from './store/actions';
import { type EphemeralMethods, ephemeralMethods } from './store/ephemeral';
import { type HandoffMethods, handoffMethods } from './store/handoffs';
import { logMethods, purgeExpired } from './store/logs';
import { apiKeyMethods, sessionMethods } from './store/sessions';
import { snapshotMethods } from './store/snapshots';
import { userMethods } from './store/users';

type SessionMethods = ReturnType<typeof sessionMethods>;

/** The core Store plus the Worker-only extras (single-query session lookup, hand-off codes, pending OAuth requests, rate limits, retention sweep). */
export interface D1Store extends Store, HandoffMethods, EphemeralMethods {
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
    ...logMethods(db),
    ...handoffMethods(db),
    ...ephemeralMethods(db),
    purgeExpired: (now) => purgeExpired(db, now),
  };
}
