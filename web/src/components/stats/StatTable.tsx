import type { ReactNode } from 'react';
import { EmptyState } from '../EmptyState';

export interface StatRow {
  key: string;
  label: ReactNode;
  /** One value per numeric column. */
  cells: ReactNode[];
}

/** Compact table: a label column followed by right-aligned numeric columns. */
export function StatTable({
  head,
  rows,
  empty,
  mono = false,
}: {
  /** Column headers, label column first. */
  head: string[];
  rows: StatRow[];
  empty: string;
  /** Label column holds identifiers (tool names). */
  mono?: boolean;
}) {
  if (rows.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="table-wrap">
      <table className="table stat-table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} scope="col" className={i === 0 ? undefined : 'num'}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className={mono ? 'mono' : 'nowrap'}>{r.label}</td>
              {r.cells.map((c, i) => (
                <td key={head[i + 1]} className="num">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
