/**
 * Write targets: what a prepared action would change in Moodle, as a key ("<kind>:<ids>"). Two actions of a user with
 * the same key are rival versions of one write; once one of them ran, the ones that were pending meanwhile are stale
 * (`superseded`) instead of running a second time. Pure: the stores share these rules.
 */

import type { ActionRow } from '../../context';
import { GMAIL_ID_RE } from '../../mail/gmail';
import type { ActionKind } from '../../types';

type Raw = Record<string, unknown>;

/** Positive integer ids only; anything else leaves the action without a target. */
const id = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
const forumType = (v: unknown): string | null => (v === 'forum' || v === 'hsuforum' ? v : null);

const keyOf = (kind: ActionKind, ...parts: Array<string | number | null>): string | null =>
  parts.some((p) => p === null) ? null : [kind, ...parts].join(':');

const gmailId = (v: unknown): string | null => (typeof v === 'string' && GMAIL_ID_RE.test(v) ? v : null);

function messageTarget(p: Raw): string | null {
  // the executor sends to the conversation whenever there is one
  const conversationId = id(p.conversationId);
  if (conversationId !== null) return `message:c${conversationId}`;
  if (p.conversationId !== null && p.conversationId !== undefined) return null;
  const toUserId = id(p.toUserId);
  return toUserId === null ? null : `message:u${toUserId}`;
}

/** The target key of an action, or null when it cannot conflict (mark_read) or its ids are missing / invalid. */
export function actionTarget(kind: ActionKind, payload: Raw): string | null {
  switch (kind) {
    case 'forum_discussion':
      return keyOf(kind, forumType(payload.forumType), id(payload.forumId));
    case 'forum_reply':
      return keyOf(kind, forumType(payload.forumType), id(payload.postId));
    case 'forum_post_edit':
    case 'forum_post_delete':
      return keyOf(kind, id(payload.postId));
    case 'forum_subscription':
      return keyOf(kind, id(payload.forumId));
    case 'assign_submit':
    case 'completion':
    case 'questionnaire_submit':
      return keyOf(kind, id(payload.cmid));
    case 'message':
      return messageTarget(payload);
    case 'mail_reply':
      return keyOf(kind, gmailId(payload.messageId));
    case 'mail_send':
      return null; // independent mails never conflict
    default:
      return null; // mark_read is idempotent
  }
}

/**
 * Part of the error of a failed run that may still have gone through (Moodle or Gmail unreachable mid-write, worker
 * lost). Such a failure counts as a run for its rivals: they are blocked / superseded like after an executed one.
 * Errors read "Check Moodle <mark>" / "Check Sent mail <mark>"; rows from before mail still contain the mark.
 */
export const UNCERTAIN_MARK = 'to see whether it went through';

/** Stored as the result of a superseded action. */
export const SUPERSEDED_RESULT = 'Another action for the same target already ran.';

/**
 * An 'executing' row is in flight until this long past its expiry; after that its worker is presumed lost (the row is
 * settled as failed on its next confirm) and it no longer blocks rival actions.
 */
export const STALE_EXECUTING_MS = 10 * 60_000;

type Rival = Pick<ActionRow, 'id' | 'userId' | 'target' | 'status' | 'executedAt' | 'expiresAt' | 'error'>;
type Claimant = Pick<ActionRow, 'id' | 'userId' | 'target' | 'createdAt'>;

const isRival = (s: Rival, row: Claimant): boolean =>
  !!row.target && s.userId === row.userId && s.target === row.target && s.id !== row.id;

/** Executed, or failed in a way that may have gone through. */
const mayHaveRun = (s: Rival): boolean =>
  s.status === 'executed' || (s.status === 'failed' && (s.error ?? '').includes(UNCERTAIN_MARK));

/** A rival that ran (executed, or failed uncertainly) while `row` was pending: `row` is stale. */
const ranSince = (s: Rival, row: Claimant): boolean =>
  isRival(s, row) && mayHaveRun(s) && s.executedAt !== null && s.executedAt >= row.createdAt;

/** A rival still in flight. */
const runningRival = (s: Rival, row: Claimant, now: number): boolean =>
  isRival(s, row) && s.status === 'executing' && s.expiresAt > now - STALE_EXECUTING_MS;

/** The claim guard: `row` may not move to 'executing' while a rival runs or after one ran while it was pending. */
export const blocksClaim = (s: Rival, row: Claimant, now: number): boolean =>
  runningRival(s, row, now) || ranSince(s, row);

/**
 * For the in-memory stores' `supersedeActions`: ids of the user's pending, unexpired rows of `target` that a rival ran
 * since (the rows the store then moves to 'superseded' with SUPERSEDED_RESULT).
 */
export function supersedableIds(rows: Iterable<ActionRow>, userId: number, target: string, now: number): string[] {
  const all = [...rows];
  return all
    .filter(
      (r) =>
        r.userId === userId &&
        r.target === target &&
        r.status === 'pending' &&
        r.expiresAt > now &&
        all.some((s) => ranSince(s, r)),
    )
    .map((r) => r.id);
}
