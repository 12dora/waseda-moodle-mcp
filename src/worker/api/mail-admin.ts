/**
 * Operator review of mail access applications (Google's user slots are limited: approval keeps use fair). Non-operators
 * get the same 404 as an unknown route, like /api/admin/stats.
 */

import { Hono, type MiddlewareHandler } from 'hono';
import { InvalidInput, NotFound } from '../../core/errors';
import type { MailAccessDecision, MailAccessStatus } from '../../core/mail/access';
import { type AppEnv, deferOn } from '../auth';
import { adminMoodleUserIds, mailSlotsOf } from '../env';
import type { D1Store } from '../store-d1';
import { disconnectMail, NOT_APPROVED } from './mail';
import { oneOf, session, storeOf } from './shared';

const LIST_LIMIT = 200;
const STATUSES = ['pending', 'approved', 'rejected'] as const;

const DECIDE_PATH = '/api/admin/mail/requests/:userId{[0-9]+}/:decision{approve|reject|revoke}';

type Decision = 'approve' | 'reject' | 'revoke';

const UNDECIDED = 'The request is not pending.';
const APPROVED = 'The request is already approved.';
const CHANGED = 'The request changed. Reload and try again.';

interface DecisionRule {
  /** The application states the decision applies to. */
  from: readonly MailAccessStatus[];
  to: MailAccessDecision;
  action: string;
  /** InvalidInput message for an application in another state. */
  error: string;
  /**
   * Revoking: also applies to a user holding a mail credential in any state (or none). Writes the status FIRST (row
   * created when missing), then ends the connection: a callback storing a connection meanwhile re-checks the approval
   * after storing and finds it gone, so revoking always ends with no connection and not approved.
   */
  ends: boolean;
}

/** Each decision moves an application from some states to another. */
const DECISIONS: Record<Decision, DecisionRule> = {
  approve: { from: ['pending', 'rejected'], to: 'approved', action: 'mail:approved', error: APPROVED, ends: false },
  reject: { from: ['pending'], to: 'rejected', action: 'mail:rejected', error: UNDECIDED, ends: false },
  revoke: { from: ['approved'], to: 'rejected', action: 'mail:revoked', error: NOT_APPROVED, ends: true },
};

/** Throws InvalidInput when `rule` does not apply to the user's application (or, revoking, mail connection). */
async function checkDecision(store: D1Store, rule: DecisionRule, userId: number): Promise<void> {
  const row = await store.getMailAccess(userId);
  if (row && rule.from.includes(row.status)) return;
  if (rule.ends && (await store.getMailCredential(userId))) return;
  throw new InvalidInput(rule.error);
}

const operatorOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!adminMoodleUserIds(c.env).has(c.get('user').moodleUserId)) throw new NotFound('Not found.');
  await next();
};

export function mailAdminRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/admin/mail/requests', session, operatorOnly, async (c) => {
    const raw = c.req.query('status');
    const message = 'status must be pending, approved or rejected.';
    const status = oneOf(raw === undefined || raw === '' ? 'pending' : raw, STATUSES, message);
    const store = storeOf(c.env);
    const [requests, used] = await Promise.all([
      store.listMailAccess({ status, limit: LIST_LIMIT, except: [...adminMoodleUserIds(c.env)] }),
      store.countMailSlots(),
    ]);
    return c.json({ requests, slots: { used, limit: mailSlotsOf(c.env) } });
  });

  app.post(DECIDE_PATH, session, operatorOnly, async (c) => {
    const key = c.req.param('decision') as Decision;
    const decision = DECISIONS[key];
    const store = storeOf(c.env);
    const target = await store.getUser(Number(c.req.param('userId')));
    if (!target) throw new InvalidInput('Unknown user.');
    if (adminMoodleUserIds(c.env).has(target.moodleUserId)) throw new InvalidInput('Operators are always approved.');
    await checkDecision(store, decision, target.id);
    const now = Date.now();
    const from = decision.ends ? null : decision.from;
    const change = { status: decision.to, by: c.get('user').moodleUserId, at: now, from };
    if (!(await store.decideMailAccess(target.id, change))) throw new InvalidInput(CHANGED);
    if (decision.ends) await disconnectMail(c.env, target.id);
    deferOn(c, store.audit({ userId: target.id, at: now, actor: 'operator', action: decision.action, detail: {} }));
    return c.json({ status: decision.to });
  });

  return app;
}
