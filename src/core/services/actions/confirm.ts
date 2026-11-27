/** Confirm / cancel / list: owner checks, expiry, approval mode, idempotent execution and audit. */

import type { ActionRow, MailApi, MoodleApi, ServiceContext, Store } from '../../context';
import {
  Forbidden,
  InvalidInput,
  MailUnavailable,
  MoodleUnavailable,
  NeedsReconnect,
  NotFound,
  WmmError,
} from '../../errors';
import { requireMail } from '../../mail/connection';
import { explainError } from '../../mcp/error-hints';
import { MOODLE_URL } from '../../moodle/launch';
import { settleChannel } from '../../moodle/web/channel';
import { isoJst, nowMs } from '../../time';
import type { ActionKind, ActionRecord, ActionResult, ActionStatus } from '../../types';
import { executeCalendarEventCreate, executeCalendarEventDelete, executeCalendarEventEdit } from './calendar';
import { executeCompletion } from './completion';
import { executeForumDiscussion, executeForumReply } from './forum';
import { executeForumPostDelete, executeForumPostEdit } from './forum-edit';
import { executeForumSubscription } from './forum-subscription';
import { executeMailReply, executeMailSend, isMailKind, type MailKind } from './mail';
import { executeMessage } from './message';
import { executeQuestionnaire } from './questionnaire';
import { executeMarkRead } from './read-state';
import { type ActionOutcome, approveUrlFor, auditSafe, canApproveInConsole, type Raw } from './shared';
import { executeSubmission } from './submission';
import { STALE_EXECUTING_MS, UNCERTAIN_MARK } from './target';

type Via = 'mcp' | 'console';

const ALREADY_RUNNING = 'This action is already running.';
const RIVAL_RUNNING = 'Another action for the same target is running.';
const SUPERSEDED = 'Another action for the same target already ran. Prepare it again if you still need it.';
const CHANNEL_CHANGED = 'The Moodle connection changed since this action was prepared. Prepare it again.';

const MOODLE_EXECUTORS: Record<
  Exclude<ActionKind, MailKind>,
  (api: MoodleApi, payload: Raw) => Promise<ActionOutcome>
> = {
  assign_submit: executeSubmission,
  forum_reply: executeForumReply,
  forum_discussion: executeForumDiscussion,
  message: executeMessage,
  completion: executeCompletion,
  mark_read: executeMarkRead,
  forum_subscription: executeForumSubscription,
  forum_post_edit: executeForumPostEdit,
  forum_post_delete: executeForumPostDelete,
  questionnaire_submit: executeQuestionnaire,
  calendar_event_create: executeCalendarEventCreate,
  calendar_event_edit: executeCalendarEventEdit,
  calendar_event_delete: executeCalendarEventDelete,
};

const MAIL_EXECUTORS: Record<MailKind, (api: MailApi, p: Raw) => Promise<ActionOutcome>> = {
  mail_send: executeMailSend,
  mail_reply: executeMailReply,
};

const checkUncertain = (kind: ActionKind) => `Check ${isMailKind(kind) ? 'Sent mail' : 'Moodle'} ${UNCERTAIN_MARK}`;

const num = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? v : null);

/** The Moodle page that shows whether a write went through (stored page URLs first, then the forum ids). */
function checkUrl(kind: ActionKind, p: Raw): string | null {
  const stored = [p.assignUrl, p.url].find((u): u is string => typeof u === 'string' && /^https:\/\//.test(u));
  if (stored) return stored;
  const mod = p.forumType === 'hsuforum' ? 'hsuforum' : 'forum';
  const discussion = num(p.discussionId);
  if (discussion) return `${MOODLE_URL}/mod/${mod}/discuss.php?d=${discussion}`;
  const forum = num(p.forumId);
  if (forum) return `${MOODLE_URL}/mod/${mod}/view.php?f=${forum}`;
  return kind === 'message' ? `${MOODLE_URL}/message/index.php` : null;
}

/** Pending rows past their expiry read as expired even before anyone touches them. */
function effectiveStatus(row: ActionRow): ActionStatus {
  return row.status === 'pending' && row.expiresAt <= nowMs() ? 'expired' : row.status;
}

async function loadOwned(ctx: ServiceContext, actionId: string): Promise<ActionRow> {
  const row = actionId ? await ctx.store.getAction(actionId) : null;
  if (!row || row.userId !== ctx.user.id) throw new NotFound('Action not found.');
  return row;
}

/** Result text as stored: the message, plus the outcome URL on a second line when there is one. */
const encodeResult = (o: ActionOutcome): string => (o.url ? `${o.message}\n${o.url}` : o.message);

function decodeResult(result: string | null): { message: string; url: string | null } {
  const text = result ?? 'Done.';
  const cut = text.lastIndexOf('\n');
  const tail = cut >= 0 ? text.slice(cut + 1) : '';
  return /^https?:\/\//.test(tail) ? { message: text.slice(0, cut), url: tail } : { message: text, url: null };
}

/** The stored outcome of an already executed (or failed) action. */
function resultOf(row: ActionRow): ActionResult {
  if (row.status === 'failed')
    return { actionId: row.id, status: 'failed', message: row.error ?? 'Failed.', url: null };
  return { actionId: row.id, status: row.status, ...decodeResult(row.result) };
}

/**
 * Best effort: the Moodle write already happened, so a failing bookkeeping update must not hide the result. Only a
 * throw is retried; a lost transition (a stale-run sweep settled the row meanwhile) leaves the row as it is.
 */
async function recordOutcome(ctx: ServiceContext, id: string, patch: Parameters<Store['updateAction']>[1]) {
  try {
    await ctx.store.updateAction(id, patch);
  } catch {
    await ctx.store.updateAction(id, patch).catch(() => undefined);
  }
}

function failDetail(row: ActionRow, error: string): Record<string, unknown> {
  const base = { id: row.id, kind: row.kind, status: 'failed' };
  // Mail errors can echo third-party addresses (Gmail 400); the action row still holds `error`.
  return isMailKind(row.kind) ? base : { ...base, error };
}

async function failAction(ctx: ServiceContext, row: ActionRow, via: Via, error: string): Promise<ActionResult> {
  await recordOutcome(ctx, row.id, { status: 'failed', executedAt: nowMs(), error });
  await auditSafe(ctx, 'action:execute', failDetail(row, error), via);
  if (error.includes(UNCERTAIN_MARK)) await supersedeRivals(ctx, row, via); // it may have gone through
  return { actionId: row.id, status: 'failed', message: error, url: null };
}

/** An 'executing' row is normally another request mid-flight; one long past its expiry lost its worker. */
async function settleExecuting(ctx: ServiceContext, row: ActionRow, via: Via): Promise<ActionResult> {
  if (nowMs() <= row.expiresAt + STALE_EXECUTING_MS) throw new InvalidInput(ALREADY_RUNNING);
  const error = `The action was interrupted. ${checkUncertain(row.kind)} before preparing it again.${where(row)}`;
  return failAction(ctx, row, via, error);
}

/**
 * Settles a pending action past its expiry. Only the request that moves it records (and counts) the expiry; false
 * means another request (a list, a purge, a confirm or cancel) moved it first.
 */
async function settleExpired(ctx: ServiceContext, row: ActionRow, via: Via): Promise<boolean> {
  if (row.status !== 'pending' || !(await ctx.store.updateAction(row.id, { status: 'expired' }))) return false;
  await auditSafe(ctx, 'action:expire', { id: row.id, kind: row.kind }, via);
  return true;
}

/**
 * Final actions answer with their stored result; cancelled / superseded / expired / running ones refuse; pending ones
 * return null.
 */
async function settledResult(ctx: ServiceContext, row: ActionRow, via: Via): Promise<ActionResult | null> {
  if (row.status === 'executed' || row.status === 'failed') return resultOf(row);
  if (row.status === 'cancelled') throw new InvalidInput('This action was cancelled.');
  if (row.status === 'superseded') throw new InvalidInput(SUPERSEDED);
  if (row.status === 'executing') return settleExecuting(ctx, row, via);
  if (effectiveStatus(row) === 'expired') {
    await settleExpired(ctx, row, via);
    throw new InvalidInput('This action has expired. Prepare it again.');
  }
  return null;
}

/** Write mode / scope / approval rules, evaluated against the user's CURRENT settings. */
async function assertMayExecute(ctx: ServiceContext, row: ActionRow, via: Via): Promise<void> {
  const fresh = (await ctx.store.getUser(ctx.user.id)) ?? ctx.user;
  const mode = fresh.settings.writeMode;
  if (mode === 'off') throw new Forbidden('Write actions are turned off in settings.');
  if (via !== 'mcp') return;
  if (!ctx.scopes.includes('moodle:write')) throw new Forbidden('This connection is read-only.');
  const needsConsole = row.approval === 'console' || (mode === 'console' && canApproveInConsole(ctx));
  if (needsConsole) throw new Forbidden(`Approve this action in the console: ${approveUrlFor(ctx, row.id)}`);
}

/**
 * Best effort, like recordOutcome: the user's other pending actions of `target` that `ran` ran since become
 * 'superseded' (the store counts each once). One audit entry lists them.
 */
async function supersedeRivals(ctx: ServiceContext, ran: ActionRow, via: Via): Promise<void> {
  if (!ran.target) return;
  const ids = await ctx.store.supersedeActions(ran.userId, ran.target, nowMs()).catch(() => []);
  if (ids.length) await auditSafe(ctx, 'action:supersede', { ids, kind: ran.kind, after: ran.id }, via);
}

/**
 * The claim failed but the row is still pending and unexpired: a rival blocks it. One that already ran makes it
 * superseded (whichever request moves it counts it); one still running answers "running".
 */
async function refuseBlocked(ctx: ServiceContext, row: ActionRow, via: Via): Promise<ActionResult> {
  if (!row.target) throw new InvalidInput(ALREADY_RUNNING);
  const ids = await ctx.store.supersedeActions(row.userId, row.target, nowMs()).catch(() => []);
  if (ids.length) await auditSafe(ctx, 'action:supersede', { ids, kind: row.kind }, via);
  // answered from the row as it is now: superseded by us or by the rival's own run, or still pending
  const settled = await settledResult(ctx, await loadOwned(ctx, row.id), via);
  if (settled) return settled;
  throw new InvalidInput(RIVAL_RUNNING);
}

/**
 * Moodle payloads hold channel-specific ids (savePreview records the channel; payloads from before it are 'ws').
 * A fresh client on 'ws' may still fall back to 'web' on its first call (whichever channel the action was prepared
 * on), so one read settles it before any write.
 */
async function assertSameChannel(api: MoodleApi, payload: Raw): Promise<void> {
  const prepared = payload.channel === 'web' ? 'web' : 'ws';
  await settleChannel(api);
  if (api.channel !== prepared) throw new InvalidInput(CHANNEL_CHANGED);
}

interface Executor {
  run: () => Promise<ActionOutcome>;
  /** Requests so far that may have changed the target (MoodleApi.writesSent; a mail send is one request). */
  writes: () => number;
}

/** Resolves the API client. A throw here means the write never left (missing mail, reconnect, channel changed). */
async function bindExecutor(ctx: ServiceContext, row: ActionRow): Promise<Executor> {
  if (isMailKind(row.kind)) {
    const run = MAIL_EXECUTORS[row.kind];
    const api = await requireMail(ctx);
    return { run: () => run(api, row.payload), writes: () => 0 };
  }
  const run = MOODLE_EXECUTORS[row.kind];
  const api = await ctx.moodle();
  await assertSameChannel(api, row.payload);
  return { run: () => run(api, row.payload), writes: () => api.writesSent ?? 0 };
}

/** Hands the claim back: the write never left, so the row stays pending. */
async function handBack(ctx: ServiceContext, id: string, e: unknown): Promise<never> {
  await ctx.store.updateAction(id, { status: 'pending' }).catch(() => undefined);
  throw e;
}

/** `written` = a request that may have changed Moodle left before the failure. */
function isUncertain(e: unknown, written: boolean): boolean {
  if (e instanceof MoodleUnavailable || (written && e instanceof NeedsReconnect)) return true;
  return e instanceof MailUnavailable && e.maybeSent;
}

/** " <url>" of the page to check, or ''. Kept after UNCERTAIN_MARK so the mark stays in the stored text. */
function where(row: ActionRow): string {
  const url = isMailKind(row.kind) ? null : checkUrl(row.kind, row.payload);
  return url ? ` ${url}` : '';
}

/** What failed plus the next step: an uncertain write is checked first; others get the central hint. */
function failMessage(ctx: ServiceContext, row: ActionRow, e: unknown, written = false): string {
  if (!(e instanceof WmmError)) return 'Unexpected error while executing the action.';
  if (isUncertain(e, written)) return `${e.message} ${checkUncertain(row.kind)} before retrying.${where(row)}`;
  // the executor's errors are about the target (a deleted thread, a closed assignment), not about the action id
  return explainError(e, { mode: ctx.mode, publicUrl: ctx.publicUrl });
}

/** Missing mail connection (requireMail). Gmail 404 from the executor is a definite failure, not this. */
function clientMissing(kind: ActionKind, e: unknown): boolean {
  if (e instanceof NeedsReconnect) return true; // includes MailNeedsReconnect
  return isMailKind(kind) && e instanceof NotFound;
}

async function runAction(ctx: ServiceContext, row: ActionRow, via: Via): Promise<ActionResult> {
  let executor: Executor;
  try {
    executor = await bindExecutor(ctx, row);
  } catch (e) {
    // nothing was written yet: an unreachable Moodle (channel check) leaves the action pending, not uncertain
    if (clientMissing(row.kind, e) || e instanceof MoodleUnavailable) return handBack(ctx, row.id, e);
    return failAction(ctx, row, via, failMessage(ctx, row, e));
  }
  const before = executor.writes();
  let outcome: ActionOutcome;
  try {
    outcome = await executor.run();
  } catch (e) {
    // a reconnect before anything that may write was sent hands the action back; after one, it may have gone
    // through (a read after the write failed). A Gmail 404 (deleted thread) fails definitely.
    const written = executor.writes() > before;
    if (e instanceof NeedsReconnect && !written) return handBack(ctx, row.id, e);
    return failAction(ctx, row, via, failMessage(ctx, row, e, written));
  }
  await recordOutcome(ctx, row.id, { status: 'executed', executedAt: nowMs(), result: encodeResult(outcome) });
  await auditSafe(ctx, 'action:execute', { id: row.id, kind: row.kind, status: 'executed' }, via);
  await supersedeRivals(ctx, row, via);
  return { actionId: row.id, status: 'executed', ...outcome };
}

/**
 * `via: 'console'` is the owner approving in the console; `'mcp'` is the AI client confirming in chat.
 * The store's atomic claim makes sure exactly one caller executes; the others get the stored result or "running".
 */
export async function confirmAction(ctx: ServiceContext, actionId: string, via: Via): Promise<ActionResult> {
  const row = await loadOwned(ctx, actionId);
  const settled = await settledResult(ctx, row, via);
  if (settled) return settled;
  await assertMayExecute(ctx, row, via);
  if (await ctx.store.claimAction(row.id, ctx.user.id, nowMs())) return runAction(ctx, row, via);
  const fresh = await loadOwned(ctx, actionId);
  const current = await settledResult(ctx, fresh, via);
  if (current) return current;
  return refuseBlocked(ctx, fresh, via);
}

export async function cancelAction(ctx: ServiceContext, actionId: string, via: Via = 'mcp'): Promise<ActionResult> {
  const row = await loadOwned(ctx, actionId);
  if (row.status === 'executed') throw new InvalidInput('This action was already executed and cannot be cancelled.');
  if (row.status === 'executing') throw new InvalidInput(ALREADY_RUNNING);
  const status = effectiveStatus(row);
  // a confirm (or an expiry) that moved it after our read wins: answer from the row as it is now
  if (status === 'pending') {
    if (!(await ctx.store.updateAction(row.id, { status: 'cancelled' }))) return cancelAction(ctx, actionId, via);
    await auditSafe(ctx, 'action:cancel', { id: row.id, kind: row.kind }, via);
    return { actionId: row.id, status: 'cancelled', message: 'Cancelled.', url: null };
  }
  if (row.status === 'pending' && !(await settleExpired(ctx, row, via))) return cancelAction(ctx, actionId, via);
  return { actionId: row.id, status, message: status === 'cancelled' ? 'Cancelled.' : `Already ${status}.`, url: null };
}

function toRecord(r: ActionRow): ActionRecord {
  return {
    id: r.id,
    kind: r.kind,
    status: effectiveStatus(r),
    title: r.title,
    details: r.details,
    warnings: r.warnings,
    approval: r.approval,
    source: r.source,
    createdAt: isoJst(r.createdAt),
    expiresAt: isoJst(r.expiresAt),
    executedAt: r.executedAt === null ? null : isoJst(r.executedAt),
    result: r.result,
    error: r.error,
  };
}

export async function listActionRecords(
  ctx: ServiceContext,
  opts: { status?: ActionStatus; limit?: number; before?: number } = {},
): Promise<ActionRecord[]> {
  const rows = await ctx.store.listActions(ctx.user.id, {
    status: opts.status,
    limit: Math.min(Math.max(opts.limit ?? 50, 1), 200),
    before: opts.before,
  });
  const records = rows.map(toRecord);
  return opts.status === 'pending' ? records.filter((r) => r.status === 'pending') : records;
}
