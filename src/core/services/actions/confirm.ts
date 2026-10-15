/** Confirm / cancel / list: owner checks, expiry, approval mode, idempotent execution and audit. */

import type { ActionRow, MoodleApi, ServiceContext, Store } from '../../context';
import { Forbidden, InvalidInput, MoodleUnavailable, NeedsReconnect, NotFound, WmmError } from '../../errors';
import { isoJst, nowMs } from '../../time';
import type { ActionKind, ActionRecord, ActionResult, ActionStatus } from '../../types';
import { executeCompletion } from './completion';
import { executeForumDiscussion, executeForumReply } from './forum';
import { executeForumSubscription } from './forum-subscription';
import { executeMessage } from './message';
import { executeMarkRead } from './read-state';
import { type ActionOutcome, approveUrlFor, auditSafe, canApproveInConsole, type Raw } from './shared';
import { executeSubmission } from './submission';

type Via = 'mcp' | 'console';

const ALREADY_RUNNING = 'This action is already running.';
const STALE_EXECUTING_MS = 10 * 60_000;

const EXECUTORS: Record<ActionKind, (api: MoodleApi, payload: Raw) => Promise<ActionOutcome>> = {
  assign_submit: executeSubmission,
  forum_reply: executeForumReply,
  forum_discussion: executeForumDiscussion,
  message: executeMessage,
  completion: executeCompletion,
  mark_read: executeMarkRead,
  forum_subscription: executeForumSubscription,
};

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

/** Best effort: the Moodle write already happened, so a failing bookkeeping update must not hide the result. */
async function recordOutcome(ctx: ServiceContext, id: string, patch: Parameters<Store['updateAction']>[1]) {
  try {
    await ctx.store.updateAction(id, patch);
  } catch {
    await ctx.store.updateAction(id, patch).catch(() => undefined);
  }
}

async function failAction(ctx: ServiceContext, row: ActionRow, via: Via, error: string): Promise<ActionResult> {
  await recordOutcome(ctx, row.id, { status: 'failed', executedAt: nowMs(), error });
  await auditSafe(ctx, 'action:execute', { id: row.id, kind: row.kind, status: 'failed', error }, via);
  return { actionId: row.id, status: 'failed', message: error, url: null };
}

/** An 'executing' row is normally another request mid-flight; one long past its expiry lost its worker. */
async function settleExecuting(ctx: ServiceContext, row: ActionRow, via: Via): Promise<ActionResult> {
  if (nowMs() <= row.expiresAt + STALE_EXECUTING_MS) throw new InvalidInput(ALREADY_RUNNING);
  const error = 'The action was interrupted. Check Moodle to see whether it went through before preparing it again.';
  return failAction(ctx, row, via, error);
}

/** Final actions answer with their stored result; cancelled / expired / running ones refuse; pending ones return null. */
async function settledResult(ctx: ServiceContext, row: ActionRow, via: Via): Promise<ActionResult | null> {
  if (row.status === 'executed' || row.status === 'failed') return resultOf(row);
  if (row.status === 'cancelled') throw new InvalidInput('This action was cancelled.');
  if (row.status === 'executing') return settleExecuting(ctx, row, via);
  if (effectiveStatus(row) === 'expired') {
    if (row.status === 'pending') {
      await ctx.store.updateAction(row.id, { status: 'expired' });
      await auditSafe(ctx, 'action:expire', { id: row.id, kind: row.kind }, via);
    }
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

async function runAction(ctx: ServiceContext, row: ActionRow, via: Via): Promise<ActionResult> {
  let outcome: ActionOutcome;
  try {
    outcome = await EXECUTORS[row.kind](await ctx.moodle(), row.payload);
  } catch (e) {
    if (e instanceof NeedsReconnect) {
      // The rejected call did nothing and the earlier steps are idempotent saves: hand the action back for a retry.
      await ctx.store.updateAction(row.id, { status: 'pending' }).catch(() => undefined);
      throw e;
    }
    let error = e instanceof WmmError ? e.message : 'Unexpected error while executing the action.';
    if (e instanceof MoodleUnavailable) error += ' Check Moodle to see whether it went through before retrying.';
    return failAction(ctx, row, via, error);
  }
  await recordOutcome(ctx, row.id, { status: 'executed', executedAt: nowMs(), result: encodeResult(outcome) });
  await auditSafe(ctx, 'action:execute', { id: row.id, kind: row.kind, status: 'executed' }, via);
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
  const current = await settledResult(ctx, await loadOwned(ctx, actionId), via);
  if (current) return current;
  throw new InvalidInput(ALREADY_RUNNING);
}

export async function cancelAction(ctx: ServiceContext, actionId: string, via: Via = 'mcp'): Promise<ActionResult> {
  const row = await loadOwned(ctx, actionId);
  if (row.status === 'executed') throw new InvalidInput('This action was already executed and cannot be cancelled.');
  if (row.status === 'executing') throw new InvalidInput(ALREADY_RUNNING);
  const status = effectiveStatus(row);
  if (status === 'pending') {
    await ctx.store.updateAction(row.id, { status: 'cancelled' });
    await auditSafe(ctx, 'action:cancel', { id: row.id, kind: row.kind }, via);
    return { actionId: row.id, status: 'cancelled', message: 'Cancelled.', url: null };
  }
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
