/** Helpers shared by every write-action kind: guards, audit, preview storage, loose Moodle-payload readers. */

import type { ActionRow, MoodleApi, ServiceContext } from '../../context';
import { randomId } from '../../crypto';
import { Forbidden, InvalidInput, MoodleError } from '../../errors';
import { isoJst, nowMs } from '../../time';
import type { ActionKind, ActionPreview } from '../../types';

const ACTION_TTL_MS = 30 * 60_000;
/** Hard per-file ceiling for anything passed through this service. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Hard ceiling for all files of one upload draft. */
export const MAX_DRAFT_TOTAL_BYTES = 50 * 1024 * 1024;
/** Upload links without a Moodle file-count limit. */
export const DEFAULT_MAX_FILES = 20;

export type Raw = Record<string, unknown>;
export interface ActionOutcome {
  message: string;
  url: string | null;
}

export const isRec = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const isSet = (v: unknown): boolean => v !== undefined && v !== null;
export const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

const MAX_PREVIEW_CHARS = 4000;

/** The text the user is about to send, in full (console approval needs it), bounded for sanity. */
export function previewText(text: string): string {
  if (text.length <= MAX_PREVIEW_CHARS) return text;
  return `${text.slice(0, MAX_PREVIEW_CHARS)}… (${text.length - MAX_PREVIEW_CHARS} more chars)`;
}

export function positiveInt(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new InvalidInput(`${name} must be a positive integer.`);
  }
  return v;
}

/** Trimmed, non-empty, bounded user text. */
export function requireText(v: unknown, label: string, max: number): string {
  const text = typeof v === 'string' ? v.trim() : '';
  if (!text) throw new InvalidInput(`The ${label} is empty.`);
  if (text.length > max) throw new InvalidInput(`The ${label} is too long (max ${max} characters).`);
  return text;
}

// ------------------------------------------------------------------ guards, audit

export function assertWriteAllowed(ctx: ServiceContext): void {
  if (!ctx.scopes.includes('moodle:write')) throw new Forbidden('This connection is read-only.');
  if (ctx.user.settings.writeMode === 'off') throw new Forbidden('Write actions are turned off in settings.');
}

/** The console exists only for the hosted service. */
export const canApproveInConsole = (ctx: ServiceContext): boolean => ctx.mode !== 'stdio' && ctx.publicUrl !== '';

export function approveUrlFor(ctx: ServiceContext, actionId: string): string {
  return `${ctx.publicUrl}/actions?focus=${encodeURIComponent(actionId)}`;
}

/** The actor follows how the action arrived (`via`), never the display label of the caller. */
function actorOf(ctx: ServiceContext, via?: 'mcp' | 'console'): string {
  return via === 'console' ? 'console' : `mcp:${ctx.source}`;
}

/** Audit must never break the user-visible flow. */
export async function auditSafe(
  ctx: ServiceContext,
  action: string,
  detail: Record<string, unknown> | null,
  via?: 'mcp' | 'console',
): Promise<void> {
  try {
    await ctx.store.audit({ userId: ctx.user.id, at: nowMs(), actor: actorOf(ctx, via), action, detail });
  } catch {
    /* best effort */
  }
}

// ------------------------------------------------------------------ preview storage

export interface PreviewParts {
  kind: ActionKind;
  title: string;
  details: string[];
  warnings: string[];
  payload: Raw;
}

export async function savePreview(ctx: ServiceContext, parts: PreviewParts): Promise<ActionPreview> {
  const now = nowMs();
  const approval = ctx.user.settings.writeMode === 'console' && canApproveInConsole(ctx) ? 'console' : 'chat';
  const { kind, title, details, payload } = parts;
  const warnings =
    ctx.user.settings.writeMode === 'console' && approval === 'chat'
      ? [...parts.warnings, 'Console approval is unavailable locally; confirming in chat.']
      : parts.warnings;
  const row: ActionRow = {
    id: randomId('act'),
    userId: ctx.user.id,
    kind,
    status: 'pending',
    approval,
    title,
    details,
    warnings,
    payload,
    source: ctx.source,
    createdAt: now,
    expiresAt: now + ACTION_TTL_MS,
    executedAt: null,
    result: null,
    error: null,
  };
  await ctx.store.createAction(row);
  await auditSafe(ctx, 'action:prepare', { id: row.id, kind, title });
  return {
    actionId: row.id,
    kind,
    title,
    details,
    warnings,
    expiresAt: isoJst(row.expiresAt),
    approval,
    approveUrl: approval === 'console' ? approveUrlFor(ctx, row.id) : null,
  };
}

// ------------------------------------------------------------------ Moodle response helpers

function warningList(res: unknown): unknown[] {
  if (Array.isArray(res)) return res;
  return isRec(res) && Array.isArray(res.warnings) ? res.warnings : [];
}

/** Warnings can be a bare array (assign) or `{warnings}`; returns their messages. */
function warningMessages(res: unknown): string[] {
  return warningList(res).map((w) =>
    isRec(w) ? (str(w.message) ?? str(w.warningcode) ?? 'Moodle returned a warning.') : String(w),
  );
}

/** "[prefix]Moodle <what>: <warnings>" for a refused write. */
export function refusal(what: string, res: unknown, prefix = ''): InvalidInput {
  const messages = warningMessages(res);
  return new InvalidInput(`${prefix}Moodle ${what}${messages.length ? `: ${messages.join(' ')}` : '.'}`);
}

export const hasWarnings = (res: unknown): boolean => warningMessages(res).length > 0;

/** Calls tolerated to fail when Moodle lacks the function / permission (preview enrichment only). */
export async function tryCall<T>(api: MoodleApi, fn: string, params: Raw): Promise<T | null> {
  try {
    return await api.call<T>(fn, params);
  } catch (e) {
    if (e instanceof MoodleError) return null;
    throw e;
  }
}
