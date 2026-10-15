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
  const kept: string[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i] ?? '';
    if (block.length + 1 <= budget) {
      kept.unshift(block);
      budget -= block.length + 1;
    } else {
      // the newest block always shows, clipped so the footer survives; older ones are dropped
      if (kept.length === 0) kept.push(clip(block, Math.max(200, budget - 1)));
      break;
    }
  }
  const omitted = blocks.length - kept.length;
  const lines = [...head];
  if (omitted > 0) lines.push(`… ${omitted} earlier ${noun} omitted`);
  lines.push(...kept, ...footer);
  return hardCap(lines.join('\n'));
}

/** A file list always ends with how to open its files, so a text-only client knows the next call. */
export const GET_FILE_HINT = '(open a file with get_file, passing its url)';

/** A file list; `hint: false` when the caller states the get_file hint once for several lists. */
export function fileLines(files: FileRef[], max = 8, opts: { hint?: boolean } = {}): string[] {
  const out = files.slice(0, max).map((f) => `- ${f.name} (${formatBytes(f.size)}) — ${f.url}`);
  if (files.length > max) out.push(`- … ${files.length - max} more files`);
  if (files.length > 0 && opts.hint !== false) out.push(GET_FILE_HINT);
  return out;
}
