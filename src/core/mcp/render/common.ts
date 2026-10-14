/**
 * Shared helpers for the markdown renderers. Every renderer returns at most ~4k characters
 * (lists are cut with "… N more (hint)"); the complete data always travels in structuredContent.
 */

import { formatBytes } from '../../format';
import type { FileRef } from '../../types';

export const MAX_TEXT_CHARS = 4000;

/** Trim and cut to `max` characters (never splits a surrogate pair), ending with "…". */
export function clip(s: string | null | undefined, max: number): string {
  const t = (s ?? '').trim();
  if (t.length <= max) return t;
  let end = Math.max(0, max - 1);
  const code = t.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${t.slice(0, end).trimEnd()}…`;
}

export const oneLine = (s: string | null | undefined, max: number) => clip((s ?? '').replace(/\s+/g, ' '), max);

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface Entry {
  text: string;
  /** Counted in the "… N more" tally; headings and blank lines are not items. */
  item?: boolean;
}

/** Last line of defence so no renderer can exceed the cap. */
export function hardCap(text: string): string {
  return text.length <= MAX_TEXT_CHARS + 200 ? text : clip(text, MAX_TEXT_CHARS + 200);
}

interface ListParts {
  head: string[];
  entries: Entry[];
  footer?: string[];
  /** Shown as "… N more (hint)" when entries had to be dropped. */
  hint: string;
}

/** head + as many entries as fit + "… N more (hint)" + footer, within the character cap. */
export function assemble({ head, entries, footer = [], hint }: ListParts): string {
  let budget = MAX_TEXT_CHARS - head.join('\n').length - footer.join('\n').length - 120;
  let taken = 0;
  for (const e of entries) {
    const cost = e.text.length + 1;
    if (cost > budget) break;
    budget -= cost;
    taken++;
  }
  while (taken > 0 && !entries[taken - 1]?.item) taken--; // no dangling headings / blank lines
  const dropped = entries.slice(taken).filter((e) => e.item).length;
  const lines = [...head, ...entries.slice(0, taken).map((e) => e.text)];
  if (dropped > 0) lines.push(`… ${dropped} more (${hint})`);
  lines.push(...footer);
  return hardCap(lines.join('\n'));
}

interface TailParts {
  head: string[];
  blocks: string[];
  footer?: string[];
  /** Plural noun for the "… N earlier <noun> omitted" line. */
  noun: string;
}

/** Like assemble, but keeps the NEWEST blocks (chronological lists: posts, messages). */
export function assembleTail({ head, blocks, footer = [], noun }: TailParts): string {
  let budget = MAX_TEXT_CHARS - head.join('\n').length - footer.join('\n').length - 120;
  let from = blocks.length;
  while (from > 0) {
    const cost = (blocks[from - 1]?.length ?? 0) + 1;
    if (cost > budget) break;
    budget -= cost;
    from--;
  }
  if (from === blocks.length && blocks.length > 0) from = blocks.length - 1; // always show the newest one
  const lines = [...head];
  if (from > 0) lines.push(`… ${from} earlier ${noun} omitted`);
  lines.push(...blocks.slice(from), ...footer);
  return hardCap(lines.join('\n'));
}

export function fileLines(files: FileRef[], max = 8): string[] {
  const out = files.slice(0, max).map((f) => `- ${f.name} (${formatBytes(f.size)}) — ${f.url}`);
  if (files.length > max) out.push(`- … ${files.length - max} more files`);
  return out;
}
