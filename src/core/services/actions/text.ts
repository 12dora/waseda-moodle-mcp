/** Text conversion for what we send to Moodle (HTML) and word counting for assignment limits. */

import { decodeEntities } from '../../html';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inlineMarkdown(escaped: string): string {
  // split out code spans first so their content stays literal
  return escaped
    .split(/(`[^`\n]+`)/)
    .map((seg, i) => {
      if (i % 2 === 1) return `<code>${seg.slice(1, -1)}</code>`;
      return seg
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_\n]+?)__/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<em>$2</em>')
        .replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?![_\w])/g, '$1<em>$2</em>');
    })
    .join('');
}

type MdLine =
  | { type: 'blank' }
  | { type: 'heading'; text: string }
  | { type: 'item'; tag: 'ul' | 'ol'; text: string }
  | { type: 'text' };

const LINE_PATTERNS: Array<{ re: RegExp; make: (text: string) => MdLine }> = [
  { re: /^#{1,6}\s+(.*)$/, make: (text) => ({ type: 'heading', text }) },
  { re: /^\s*[-*+]\s+(.*)$/, make: (text) => ({ type: 'item', tag: 'ul', text }) },
  { re: /^\s*\d+[.)]\s+(.*)$/, make: (text) => ({ type: 'item', tag: 'ol', text }) },
];

function classifyLine(line: string): MdLine {
  if (!line.trim()) return { type: 'blank' };
  for (const { re, make } of LINE_PATTERNS) {
    const m = re.exec(line);
    if (m) return make(m[1] ?? '');
  }
  return { type: 'text' };
}

interface MdList {
  tag: 'ul' | 'ol';
  items: string[];
}

const renderPara = (lines: string[]) => `<p>${lines.map((l) => inlineMarkdown(escapeHtml(l))).join('<br>')}</p>`;
const renderList = (l: MdList) =>
  `<${l.tag}>${l.items.map((i) => `<li>${inlineMarkdown(escapeHtml(i))}</li>`).join('')}</${l.tag}>`;

/** Small Markdown subset -> HTML: paragraphs, line breaks, lists, headings (as bold), bold/italic/code/links. */
export function markdownToSimpleHtml(md: string): string {
  const out: string[] = [];
  const state: { para: string[]; list: MdList | null } = { para: [], list: null };
  const flushPara = () => {
    if (state.para.length) out.push(renderPara(state.para));
    state.para = [];
  };
  const flushList = () => {
    if (state.list) out.push(renderList(state.list));
    state.list = null;
  };
  for (const raw of md.replace(/\r\n?/g, '\n').trim().split('\n')) {
    const line = raw.trimEnd();
    const kind = classifyLine(line);
    if (kind.type === 'item') {
      flushPara();
      if (state.list?.tag !== kind.tag) {
        flushList();
        state.list = { tag: kind.tag, items: [] };
      }
      state.list.items.push(kind.text);
    } else if (kind.type === 'text') {
      flushList();
      state.para.push(line);
    } else {
      flushPara();
      flushList();
      if (kind.type === 'heading') out.push(`<p><strong>${inlineMarkdown(escapeHtml(kind.text))}</strong></p>`);
    }
  }
  flushPara();
  flushList();
  return out.join('');
}

/** Plain text -> HTML (escape + line breaks) for chat messages. */
export function plainTextToHtml(text: string): string {
  return escapeHtml(text.replace(/\r\n?/g, '\n').trim()).replace(/\n/g, '<br>');
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu;

/** CJK characters (informational: Moodle's word limit does not split them). */
export function countCjkChars(text: string): number {
  return text.match(CJK)?.length ?? 0;
}

// Closing tags (except inline ones) and <br> delimit words even though they leave no whitespace behind.
const WORD_BREAK_TAGS = /(<\/(?!(?:a|b|del|em|i|ins|s|small|strong|sub|sup|u)>)\w+>|<br\s?\/?>)/gi;

/**
 * Moodle's count_words: HTML -> text, then runs of Unicode separators / control characters / dashes split words.
 * The text is converted exactly as it will be sent, so the count matches what Moodle checks against the limit.
 */
export function countWords(text: string): number {
  const html = markdownToSimpleHtml(text).replace(WORD_BREAK_TAGS, '$1 ');
  const plain = decodeEntities(html.replace(/<[^>]*>/g, ''));
  return plain.split(/[\p{Z}\p{Cc}\u2014\u2013]+/u).filter(Boolean).length;
}
