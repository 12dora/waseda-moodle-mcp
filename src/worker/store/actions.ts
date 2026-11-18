import type { ActionRow, Store, UploadDraftRow } from '../../core/context';
import { STALE_EXECUTING_MS, SUPERSEDED_RESULT, UNCERTAIN_MARK } from '../../core/services/actions/target';
import { ACTION_STATUS_FROM, type ActionStatus, type UploadedDraftFile } from '../../core/types';
import { usagePeriods } from '../../core/usage';
import { changes, parseJson, toJson, updateStatement } from './rows';

interface ActionRaw {
  id: string;
  user_id: number;
  kind: string;
  status: string;
  approval: string;
  title: string;
  details: string;
  warnings: string;
  payload: string;
  target: string | null;
  source: string;
  created_at: number;
  expires_at: number;
  executed_at: number | null;
  result: string | null;
  error: string | null;
}

interface UploadRaw {
  id: string;
  user_id: number;
  cmid: number;
  draft_item_id: number;
  files: string;
  total_bytes: number;
  created_at: number;
  expires_at: number;
}

const toAction = (r: ActionRaw): ActionRow => ({
  id: r.id,
  userId: r.user_id,
  kind: r.kind as ActionRow['kind'],
  status: r.status as ActionRow['status'],
  approval: r.approval as ActionRow['approval'],
  title: r.title,
  details: parseJson<string[]>(r.details, []),
  warnings: parseJson<string[]>(r.warnings, []),
  payload: parseJson<Record<string, unknown>>(r.payload, {}),
  target: r.target ?? null,
  source: r.source,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  executedAt: r.executed_at,
  result: r.result,
  error: r.error,
});

const toUpload = (r: UploadRaw): UploadDraftRow => ({
  id: r.id,
  userId: r.user_id,
  cmid: r.cmid,
  draftItemId: r.draft_item_id,
  files: parseJson<UploadedDraftFile[]>(r.files, []),
  totalBytes: r.total_bytes,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

type ActionMethods = Pick<
  Store,
  'createAction' | 'getAction' | 'claimAction' | 'supersedeActions' | 'updateAction' | 'listActions'
>;

/** Final statuses of the write funnel (operator statistics: `action_<status>` per kind, with `action_prepared`). */
const FUNNEL_STATUSES: ReadonlySet<ActionStatus> = new Set([
  'executed',
  'failed',
  'cancelled',
  'expired',
  'superseded',
]);

/** +1 on `action_<event>` for the action's kind, only if the statement right before (same batch) changed a row. */
const countAfter = (db: D1Database, id: string, event: string, now: number): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO usage_counts (period, metric, dim, value)
       SELECT ?, ?, kind, 1 FROM actions WHERE id = ? AND changes() = 1
       ON CONFLICT(period, metric, dim) DO UPDATE SET value = value + 1`,
    )
    .bind(usagePeriods(now).day, `action_${event}`, id);

/**
 * Pending actions past their expiry become `expired`, counted per kind in the same batch (so exactly once, whether the
 * purge or a read gets there first). Two statements however many rows; `userId` limits it to one user's actions.
 */
function expireStatements(db: D1Database, now: number, userId?: number): D1PreparedStatement[] {
  const mine = userId === undefined ? '' : ' AND user_id = ?';
  const args = userId === undefined ? [now] : [now, userId];
  return [
    db
      .prepare(
        `INSERT INTO usage_counts (period, metric, dim, value)
         SELECT ?, 'action_expired', kind, COUNT(*) FROM actions
         WHERE status = 'pending' AND expires_at <= ?${mine} GROUP BY kind
         ON CONFLICT(period, metric, dim) DO UPDATE SET value = value + excluded.value`,
      )
      .bind(usagePeriods(now).day, ...args),
    db
      .prepare(`UPDATE actions SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?${mine}`)
      .bind(...args),
  ];
}

/** Rival `s` ran since the outer action was created: executed, or failed uncertainly (bind: UNCERTAIN_MARK). */
const RAN_SINCE = `(s.status = 'executed' OR (s.status = 'failed' AND instr(COALESCE(s.error, ''), ?) > 0))
  AND s.executed_at >= actions.created_at`;

/**
 * A rival of the action in the outer statement (same user and target, another id) that blocks its claim (target.ts
 * blocksClaim): executing and not yet stale (bind: now - STALE_EXECUTING_MS), or ran since it was created.
 */
const BLOCKING_RIVAL = `EXISTS (SELECT 1 FROM actions s
  WHERE s.user_id = actions.user_id AND s.target = actions.target AND s.id != actions.id
    AND ((s.status = 'executing' AND s.expires_at > ?) OR (${RAN_SINCE})))`;

/**
 * The user's pending, unexpired actions of one target that a rival ran since (target.ts supersedableIds).
 * Binds: userId, target, now, UNCERTAIN_MARK.
 */
const STALE_RIVALS = `user_id = ? AND target = ? AND status = 'pending' AND expires_at > ?
  AND EXISTS (SELECT 1 FROM actions s
    WHERE s.user_id = actions.user_id AND s.target = actions.target AND s.id != actions.id AND ${RAN_SINCE})`;

/** The daily purge's share: every user's expired pending actions. */
export async function expirePendingActions(db: D1Database, now: number): Promise<number> {
  const [, expired] = await db.batch(expireStatements(db, now));
  return expired?.meta?.changes ?? 0;
}

const insertStatement = (db: D1Database, row: ActionRow): D1PreparedStatement =>
  db
    .prepare(
      `INSERT INTO actions (id, user_id, kind, status, approval, title, details, warnings, payload, target, source,
         created_at, expires_at, executed_at, result, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.userId,
      row.kind,
      row.status,
      row.approval,
      row.title,
      toJson(row.details),
      toJson(row.warnings),
      toJson(row.payload),
      row.target ?? null,
      row.source,
      row.createdAt,
      row.expiresAt,
      row.executedAt ?? null,
      row.result ?? null,
      row.error ?? null,
    );

/** Ids, funnel count (per kind) and move of the stale rivals; run as one batch (a transaction). */
function supersedeStatements(db: D1Database, userId: number, target: string, now: number): D1PreparedStatement[] {
  const args = [userId, target, now, UNCERTAIN_MARK];
  return [
    db.prepare(`SELECT id FROM actions WHERE ${STALE_RIVALS}`).bind(...args),
    db
      .prepare(
        `INSERT INTO usage_counts (period, metric, dim, value)
         SELECT ?, 'action_superseded', kind, COUNT(*) FROM actions WHERE ${STALE_RIVALS} GROUP BY kind
         ON CONFLICT(period, metric, dim) DO UPDATE SET value = value + excluded.value`,
      )
      .bind(usagePeriods(now).day, ...args),
    db
      .prepare(`UPDATE actions SET status = 'superseded', result = ? WHERE ${STALE_RIVALS}`)
      .bind(SUPERSEDED_RESULT, ...args),
  ];
}

export function actionMethods(db: D1Database): ActionMethods {
  return {
    async createAction(row) {
      await db.batch([insertStatement(db, row), countAfter(db, row.id, 'prepared', row.createdAt)]);
    },

    async getAction(id) {
      const r = await db.prepare('SELECT * FROM actions WHERE id = ?').bind(id).first<ActionRaw>();
      return r ? toAction(r) : null;
    },

    /**
     * Single-winner claim: only a pending, unexpired action of this user without a blocking rival can move to
     * 'executing'. One statement, so of two rivals claimed at once only the first sees no executing rival.
     */
    async claimAction(id, userId, now) {
      const n = await changes(
        db
          .prepare(
            `UPDATE actions SET status = 'executing'
             WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at > ? AND NOT ${BLOCKING_RIVAL}`,
          )
          .bind(id, userId, now, now - STALE_EXECUTING_MS, UNCERTAIN_MARK),
      );
      return n === 1;
    },

    /** Ids, funnel count and move in one batch (a transaction), so each superseded row is counted exactly once. */
    async supersedeActions(userId, target, now) {
      const res = await db.batch(supersedeStatements(db, userId, target, now));
      return ((res[0]?.results ?? []) as Array<{ id: string }>).map((r) => r.id);
    },

    async updateAction(id, patch) {
      const from = patch.status === undefined ? undefined : ACTION_STATUS_FROM[patch.status];
      if (patch.status !== undefined && from === undefined) return false;
      const columns = {
        status: patch.status,
        executed_at: patch.executedAt,
        result: patch.result,
        error: patch.error,
      };
      const guard = from === undefined ? undefined : { sql: 'status = ?', args: [from] };
      const update = updateStatement(db, { table: 'actions', keyColumn: 'id', key: id }, columns, guard);
      if (!update) return false;
      if (!patch.status || !FUNNEL_STATUSES.has(patch.status)) return (await changes(update)) === 1;
      // the funnel counts the transition in the same batch, only if it won
      const [res] = await db.batch([update, countAfter(db, id, patch.status, Date.now())]);
      return (res?.meta?.changes ?? 0) === 1;
    },

    async listActions(userId, opts) {
      const where = ['user_id = ?'];
      const args: unknown[] = [userId];
      if (opts.status) {
        where.push('status = ?');
        args.push(opts.status);
      }
      if (opts.target !== undefined) {
        where.push('target = ?');
        args.push(opts.target);
      }
      if (opts.before !== undefined) {
        where.push('created_at < ?');
        args.push(opts.before);
      }
      // expired pending rows are settled (and counted) first, so the read and its status filter see them as expired
      const res = await db.batch([
        ...expireStatements(db, Date.now(), userId),
        db
          .prepare(`SELECT * FROM actions WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
          .bind(...args, Math.max(1, Math.floor(opts.limit))),
      ]);
      return ((res[2]?.results ?? []) as ActionRaw[]).map(toAction);
    },
  };
}

type UploadMethods = Pick<Store, 'createUploadDraft' | 'getUploadDraft' | 'appendUploadedFile' | 'consumeUploadDraft'>;

export function uploadMethods(db: D1Database): UploadMethods {
  return {
    async createUploadDraft(row) {
      await db
        .prepare(
          `INSERT INTO upload_drafts (id, user_id, cmid, draft_item_id, files, total_bytes, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.userId,
          row.cmid,
          row.draftItemId,
          toJson(row.files),
          row.totalBytes,
          row.createdAt,
          row.expiresAt,
        )
        .run();
    },

    async getUploadDraft(id) {
      const r = await db.prepare('SELECT * FROM upload_drafts WHERE id = ?').bind(id).first<UploadRaw>();
      return r ? toUpload(r) : null;
    },

    /** Atomic append (concurrent uploads into one draft must not lose entries). */
    async appendUploadedFile(id, file) {
      await db
        .prepare(
          `UPDATE upload_drafts SET files = json_insert(files, '$[#]', json(?)), total_bytes = total_bytes + ?
           WHERE id = ?`,
        )
        .bind(toJson(file), Math.max(0, Math.floor(file.size)), id)
        .run();
    },

    /** Atomic: a second caller (or a draft that already expired) gets false. */
    async consumeUploadDraft(id) {
      const n = await changes(
        db.prepare('UPDATE upload_drafts SET expires_at = 0 WHERE id = ? AND expires_at > ?').bind(id, Date.now()),
      );
      return n === 1;
    },
  };
}
