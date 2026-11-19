/**
 * Mail cleanup (daily purge run). First a connection whose owner is neither approved nor an operator (access revoked
 * while a connect was under way, an operator removed from ADMIN_MOODLE_USERIDS) is disconnected like an operator's
 * revoke. Then a mail connection unused for MAIL_IDLE_DAYS is revoked at Google and its refresh token dropped; the row
 * stays to tell the console why the connection ended. A failed attempt is stamped (idleTriedAt), so rows that fail
 * every day go behind the others. Every idle write is conditional on the token the run read: a reconnect meanwhile is
 * never touched. Background work: no statistics.
 */

import type { InvocationBudget } from '../core/budget';
import type { MailCredentialRow } from '../core/context';
import { revokeGoogleToken } from '../core/mail/client';
import { revokeStoredMail } from './api/mail';
import { getRuntime } from './context';
import { adminMoodleUserIds, type Env, googleClientOf, mailIdleDaysOf } from './env';

const DAY_MS = 86_400_000;
/** Connections ended per run (each costs one Google request and up to two D1 queries: end, then stamp on a CAS miss). */
const BATCH = 10;

interface IdleRun {
  rt: Awaited<ReturnType<typeof getRuntime>>;
  revokeFetch: typeof fetch;
  lastError: string;
  now: number;
}

/** Revokes one connection at Google and drops its token; false when Google could not be asked (kept for next run). */
async function endConnection(run: IdleRun, row: MailCredentialRow): Promise<boolean> {
  if (!row.refreshEnc) return false;
  const revoked = await revokeGoogleToken(await run.rt.key.decrypt(row.refreshEnc), run.revokeFetch);
  if (!revoked) return false; // the token must not stay alive at Google while we forget it
  const patch = { status: 'invalid', refreshEnc: null, lastError: run.lastError } as const;
  return run.rt.store.updateMailCredentialIf(row.userId, { refreshEnc: row.refreshEnc }, patch);
}

/** Ends one connection; a failed attempt is stamped so the next runs try the others first. Never throws. */
async function visit(run: IdleRun, row: MailCredentialRow): Promise<boolean> {
  const ended = await endConnection(run, row).catch(logFailure);
  if (ended) return true;
  const expect = { refreshEnc: row.refreshEnc };
  await run.rt.store.updateMailCredentialIf(row.userId, expect, { idleTriedAt: run.now }).catch(logFailure);
  return false;
}

/**
 * Disconnects up to BATCH connections of owners neither approved nor operators (one Google request and two D1 queries
 * each); returns how many ended. Never throws.
 */
async function endUnapproved(env: Env, budget: InvocationBudget, revokeFetch: typeof fetch): Promise<number> {
  let ended = 0;
  try {
    const operators = adminMoodleUserIds(env);
    const rt = await getRuntime(env);
    // operators are listed too (they need no approval row): fetch enough to fill the batch with the others
    const owners = await rt.store.listUnapprovedMailOwners(BATCH + operators.size);
    for (const owner of owners.filter((o) => !operators.has(o.moodleUserId)).slice(0, BATCH)) {
      if (!budget.fits(1, 2)) break;
      // like the idle path: a token Google did not confirm revoked keeps its row for the next run
      if (!(await revokeStoredMail(env, owner.userId, revokeFetch))) continue;
      if (await rt.store.deleteMailCredential(owner.userId).catch(logFailure)) ended++;
    }
  } catch (e) {
    logFailure(e);
  }
  return ended;
}

/** Revokes up to BATCH idle connections within the shared budget; returns how many ended. Never throws. */
async function endIdle(
  env: Env,
  budget: InvocationBudget,
  opts: { revokeFetch: typeof fetch; days: number; now: number },
): Promise<number> {
  const { revokeFetch, days, now } = opts;
  let ended = 0;
  try {
    const rt = await getRuntime(env);
    const run: IdleRun = { rt, revokeFetch, lastError: `Disconnected after ${days} days without use.`, now };
    const rows = await rt.store.listIdleMailCredentials(now - days * DAY_MS, BATCH);
    for (const row of rows) {
      if (!budget.fits(1, 2)) break;
      if (await visit(run, row)) ended++;
    }
  } catch (e) {
    logFailure(e);
  }
  return ended;
}

/**
 * Disconnects unapproved owners' connections, then revokes up to BATCH idle connections, within the shared budget;
 * returns how many ended. Never throws.
 */
export async function runMailIdle(env: Env, budget: InvocationBudget, now = Date.now()): Promise<number> {
  if (!googleClientOf(env)) return 0;
  const revokeFetch = budget.meter((input, init) => globalThis.fetch(input, init));
  const unapproved = await endUnapproved(env, budget, revokeFetch);
  const days = mailIdleDaysOf(env);
  return days === null ? unapproved : unapproved + (await endIdle(env, budget, { revokeFetch, days, now }));
}

function logFailure(e: unknown): false {
  console.error('mail idle cleanup failed:', e instanceof Error ? e.name : 'unknown');
  return false;
}
