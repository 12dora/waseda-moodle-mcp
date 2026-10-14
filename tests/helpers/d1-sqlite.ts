/**
 * D1-compatible adapter over Node's built-in `node:sqlite` (Node >= 22.13). Implements the subset of the D1 API that
 * the Worker code uses: prepare().bind().first()/all()/run()/raw(), batch() (atomic), exec(). Foreign keys are enforced
 * like on D1.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

type SqlValue = string | number | bigint | null | Uint8Array;

function normalize(v: unknown): SqlValue {
  if (v === undefined) throw new Error('D1_TYPE_ERROR: Type "undefined" not supported for value "undefined"');
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v as SqlValue;
}

const plain = (row: unknown): Record<string, unknown> => Object.assign({}, row as Record<string, unknown>);

class Stmt {
  constructor(
    private readonly sqlite: DatabaseSync,
    readonly sql: string,
    private readonly params: SqlValue[] = [],
  ) {}

  bind(...values: unknown[]): Stmt {
    return new Stmt(this.sqlite, this.sql, values.map(normalize));
  }

  private prepared(): StatementSync {
    return this.sqlite.prepare(this.sql);
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.prepared().get(...this.params);
    if (!row) return null;
    const r = plain(row);
    return (column === undefined ? r : (r[column] ?? null)) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    const rows = this.prepared()
      .all(...this.params)
      .map(plain) as T[];
    return { results: rows, success: true, meta: { changes: 0, rows_read: rows.length } };
  }

  async run(): Promise<{ results: never[]; success: true; meta: { changes: number; last_row_id: number } }> {
    const r = this.prepared().run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const stmt = this.prepared();
    stmt.setReturnArrays(true);
    return stmt.all(...this.params) as T[];
  }
}

export interface TestD1 {
  /** Pass this to code under test. */
  db: D1Database;
  /** Direct access for assertions. */
  sqlite: DatabaseSync;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export function createTestD1(applyMigrations = true): TestD1 {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  if (applyMigrations) {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((n) => n.endsWith('.sql'))
      .sort()) {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
    }
  }

  const db = {
    prepare: (sql: string) => new Stmt(sqlite, sql),
    async batch(stmts: Stmt[]) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) {
          out.push(/^\s*(select|with|pragma)/i.test(s.sql) ? await s.all() : await s.run());
        }
        sqlite.exec('COMMIT');
        return out;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
  };
  return { db: db as unknown as D1Database, sqlite };
}
