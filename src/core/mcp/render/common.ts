/**
 * Shared helpers for the markdown renderers. The default cap is ~4k characters
 * (lists are cut with "… N more (hint)"); assembleTail accepts a larger `budget` (mail uses 40k).
 * The complete data always travels in structuredContent.
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

/**
 * For agents whose network refuses this service's host (e.g. a sandbox proxy answering HTTP 403, "CONNECT tunnel
 * failed"). Client-neutral: the user either allows the host or moves the file by hand.
 */
export function blockedLinkHint(url: string, direction: 'download' | 'upload' = 'download'): string {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* not an absolute URL */
  }
  const target = host || "this service's domain";
  const manual =
    direction === 'upload'
      ? 'or pass small files inline instead (files[].text / content_base64)'
      : 'or ask them to open the link in a browser and attach the file to the chat';
  return `If the request fails (e.g. HTTP 403, "CONNECT tunnel failed"), your network blocks ${target}. Ask the user to allow ${target} in this app's network or sandbox settings and retry, ${manual}.`;
}

/** Last line of defence so no renderer can exceed the cap. */
export function hardCap(text: string, budget = MAX_TEXT_CHARS): string {
  const cap = budget + 200;
  return text.length <= cap ? text : clip(text, cap);
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
  /** Character cap for the whole render (default MAX_TEXT_CHARS). Mail uses 40 000. */
  budget?: number;
  /** When the newest block is clipped to fit, a line after it (mail: how much was cut / Gmail). */
  onCut?: (shown: number, total: number) => string;
}

function newestBlocks(blocks: string[], startRoom: number, onCut?: (shown: number, total: number) => string): string[] {
  const kept: string[] = [];
  let room = startRoom;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i] ?? '';
    if (block.length + 1 <= room) {
      kept.unshift(block);
      room -= block.length + 1;
      continue;
    }
    if (kept.length === 0) {
      const shown = Math.max(200, room - 1);
      const head = clip(block, shown);
      kept.push(onCut ? `${head}\n${onCut(shown, block.length)}` : head);
    }
    break;
  }
  return kept;
}

/** Like assemble, but keeps the NEWEST blocks (chronological lists: posts, messages). */
export function assembleTail({ head, blocks, footer = [], noun, budget = MAX_TEXT_CHARS, onCut }: TailParts): string {
  const room = budget - head.join('\n').length - footer.join('\n').length - 120;
  const kept = newestBlocks(blocks, room, onCut);
  const omitted = blocks.length - kept.length;
  const lines = [...head];
  if (omitted > 0) lines.push(`… ${omitted} earlier ${noun} omitted`);
  lines.push(...kept, ...footer);
  return hardCap(lines.join('\n'), budget);
}

/** A file list always ends with how to open its files, so a text-only client knows the next call. */
export const GET_FILE_HINT = '(open a file with get_file, passing its url)';

/** A file list; `hint: false` when the caller states the get_file hint once for several lists. */
export function fileLines(files: FileRef[], max = 8, opts: { hint?: boolean } = {}): string[] {
  // a size of 0 means unknown (web pages do not print sizes; get_file reports the real one)
  const out = files.slice(0, max).map((f) => `- ${f.name}${f.size > 0 ? ` (${formatBytes(f.size)})` : ''} — ${f.url}`);
  if (files.length > max) out.push(`- … ${files.length - max} more files`);
  if (files.length > 0 && opts.hint !== false) out.push(GET_FILE_HINT);
  return out;
}
