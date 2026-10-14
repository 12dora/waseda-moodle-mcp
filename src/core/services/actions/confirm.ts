/** Confirm / cancel / list: owner checks, expiry, approval mode, idempotent execution and audit. */

import type { ActionRow, MoodleApi, ServiceContext } from '../../context';
import { Forbidden, InvalidInput, MoodleUnavailable, NeedsReconnect, NotFound, WmmError } from '../../errors';
import { isoJst, nowMs } from '../../time';
import type { ActionKind, ActionRecord, ActionResult, ActionStatus } from '../../types';
import { executeCompletion } from './completion';
import { executeForumDiscussion, executeForumReply } from './forum';
import { executeMessage } from './message';
import { type ActionOutcome, approveUrlFor, auditSafe, canApproveInConsole, isRec, type Raw, str } from './shared';
import { executeSubmission } from './submission';

type Via = 'mcp' | 'console';

const EXECUTORS: Record<ActionKind, (api: MoodleApi, payload: Raw) => Promise<ActionOutcome>> = {
  assign_submit: executeSubmission,
  forum_reply: executeForumReply,
  forum_discussion: executeForumDiscussion,
  message: executeMessage,
  completion: executeCompletion,
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

function resultMessage(row: ActionRow): string {
  if (row.status === 'failed') return row.error ?? 'Failed.';
  if (row.result !== null) return row.result;
  return row.status === 'executed' ? 'Done.' : row.status;
}

/** The stored outcome of an already executed (or failed) action. */
function resultOf(row: ActionRow): ActionResult {
  const payloadUrl = isRec(row.payload) ? (str(row.payload.assignUrl) ?? str(row.payload.url)) : null;
  return {
    actionId: row.id,
    status: row.status,
    message: resultMessage(row),
    url: row.status === 'executed' ? payloadUrl : null,
  };
}

/** Already-final actions answer with their stored result; cancelled / expired ones refuse; pending ones return null. */
async function settledResult(ctx: ServiceContext, row: ActionRow, via: Via): Promise<ActionResult | null> {
  if (row.status === 'executed' || row.status === 'failed') return resultOf(row);
  if (row.status === 'cancelled') throw new InvalidInput('This action was cancelled.');
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

async function recordFailure(ctx: ServiceContext, row: ActionRow, via: Via, e: unknown): Promise<ActionResult> {
  let error = e instanceof WmmError ? e.message : 'Unexpected error while executing the action.';
  if (e instanceof MoodleUnavailable) error += ' Check Moodle to see whether it went through before retrying.';
  await ctx.store.updateAction(row.id, { status: 'failed', executedAt: nowMs(), error });
  await auditSafe(ctx, 'action:execute', { id: row.id, kind: row.kind, status: 'failed', error }, via);
  return { actionId: row.id, status: 'failed', message: error, url: null };
}

async function runAction(ctx: ServiceContext, row: ActionRow, via: Via): Promise<ActionResult> {
  const api = await ctx.moodle();
  let outcome: ActionOutcome;
  try {
    outcome = await EXECUTORS[row.kind](api, row.payload);
  } catch (e) {
    if (e instanceof NeedsReconnect) throw e; // nothing was sent; the action stays pending
    return recordFailure(ctx, row, via, e);
  }
  await ctx.store.updateAction(row.id, { status: 'executed', executedAt: nowMs(), result: outcome.message });
  await auditSafe(ctx, 'action:execute', { id: row.id, kind: row.kind, status: 'executed' }, via);
  return { actionId: row.id, status: 'executed', message: outcome.message, url: outcome.url };
}

async function doConfirm(ctx: ServiceContext, actionId: string, via: Via): Promise<ActionResult> {
  const row = await loadOwned(ctx, actionId);
  const settled = await settledResult(ctx, row, via);
  if (settled) return settled;
  await assertMayExecute(ctx, row, via);
  return runAction(ctx, row, via);
}

const inflight = new Map<string, Promise<ActionResult>>();

/** `via: 'console'` is the owner approving in the console; `'mcp'` is the AI client confirming in chat. */
export function confirmAction(ctx: ServiceContext, actionId: string, via: Via): Promise<ActionResult> {
  const key = `${ctx.user.id}:${actionId}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = doConfirm(ctx, actionId, via).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export async function cancelAction(ctx: ServiceContext, actionId: string): Promise<ActionResult> {
  const row = await loadOwned(ctx, actionId);
  if (row.status === 'executed') throw new InvalidInput('This action was already executed and cannot be cancelled.');
  const status = effectiveStatus(row);
  if (status === 'pending') {
    await ctx.store.updateAction(row.id, { status: 'cancelled' });
    await auditSafe(ctx, 'action:cancel', { id: row.id, kind: row.kind });
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
