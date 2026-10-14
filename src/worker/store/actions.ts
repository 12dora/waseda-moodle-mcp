import type { ActionRow, Store, UploadDraftRow } from '../../core/context';
import type { UploadedDraftFile } from '../../core/types';
import { changes, parseJson, toJson, updateColumns } from './rows';

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

type ActionMethods = Pick<Store, 'createAction' | 'getAction' | 'claimAction' | 'updateAction' | 'listActions'>;

export function actionMethods(db: D1Database): ActionMethods {
  return {
    async createAction(row) {
      await db
        .prepare(
          `INSERT INTO actions (id, user_id, kind, status, approval, title, details, warnings, payload, source,
             created_at, expires_at, executed_at, result, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          row.source,
          row.createdAt,
          row.expiresAt,
          row.executedAt ?? null,
          row.result ?? null,
          row.error ?? null,
        )
        .run();
    },

    async getAction(id) {
      const r = await db.prepare('SELECT * FROM actions WHERE id = ?').bind(id).first<ActionRaw>();
      return r ? toAction(r) : null;
    },

    /** Single-winner claim: only a pending, unexpired action of this user can move to 'executing'. */
    async claimAction(id, userId, now) {
      const n = await changes(
        db
          .prepare(
            `UPDATE actions SET status = 'executing' WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at > ?`,
          )
          .bind(id, userId, now),
      );
      return n === 1;
    },

    async updateAction(id, patch) {
      await updateColumns(
        db,
        { table: 'actions', keyColumn: 'id', key: id },
        { status: patch.status, executed_at: patch.executedAt, result: patch.result, error: patch.error },
      );
    },

    async listActions(userId, opts) {
      const where = ['user_id = ?'];
      const args: unknown[] = [userId];
      if (opts.status) {
        where.push('status = ?');
        args.push(opts.status);
      }
      if (opts.before !== undefined) {
        where.push('created_at < ?');
        args.push(opts.before);
      }
      const { results } = await db
        .prepare(`SELECT * FROM actions WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .bind(...args, Math.max(1, Math.floor(opts.limit)))
        .all<ActionRaw>();
      return results.map(toAction);
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
