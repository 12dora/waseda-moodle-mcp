/**
 * Cheap HTML -> Markdown for Moodle fragments. One regex-driven pass over the tags, no DOM, O(n).
 * Output is for reading by people and models, not a faithful round trip.
 */

const NAMED: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  divide: '÷',
  deg: '°',
  plusmn: '±',
  euro: '€',
  yen: '¥',
  pound: '£',
  cent: '¢',
  sect: '§',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
});

/** Named (common) and numeric entities, decoded in a single pass (no double decoding). */
export function decodeEntities(s: string): string {
  if (!s || s.indexOf('&') < 0) return s;
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,9}));/g, (m, dec, hex, name) => {
    if (name) return NAMED[name] ?? NAMED[name.toLowerCase()] ?? m;
    const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '';
    return cp === 0xa0 ? ' ' : String.fromCodePoint(cp);
  });
}

// The lookahead pins the end of the tag name so the attribute part cannot re-split it (no backtracking blow-up).
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)(?![a-zA-Z0-9:-])([^<>]*)>/g;
const HREF_RE = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const SRC_RE = /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const ALT_RE = /(?:^|\s)alt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

function attr(re: RegExp, attrs: string): string {
  const m = re.exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim() : '';
}

const urlSafe = (u: string) => u.replace(/\s/g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');

/** Removes `<!-- … -->` in linear time (an unclosed comment swallows the rest). */
function stripComments(html: string): string {
  let i = html.indexOf('<!--');
  if (i < 0) return html;
  let out = '';
  let from = 0;
  while (i >= 0) {
    out += html.slice(from, i);
    const end = html.indexOf('-->', i + 4);
    if (end < 0) return out;
    from = end + 3;
    i = html.indexOf('<!--', from);
  }
  return out + html.slice(from);
}

const words = (list: string) => new Set(list.split(' '));
const BLOCK2 = words('p ul ol table blockquote section article dl figure form fieldset h1 h2 h3 h4 h5 h6');
const BLOCK1 = words('div header footer nav aside main dt dd figcaption tr caption details summary');
const SKIP_CONTENT = words('script style head template');

interface Md {
  out: string[];
  len: number;
  started: boolean;
  nl: number; // trailing newlines emitted (0-2)
  pendingSpace: boolean;
  noLead: boolean; // suppress the pending space (right after a list marker / "[")
  inPre: boolean;
  cellFirst: boolean;
  lists: Array<{ ordered: boolean; n: number }>;
  links: Array<string | null>;
}

type TagHandler = (s: Md, closing: boolean, attrs: string, tag: string) => void;

function put(s: Md, str: string): void {
  s.out.push(str);
  s.len += str.length;
}

function ensure(s: Md, n: number): void {
  s.pendingSpace = false;
  if (!s.started) return;
  while (s.nl < n) {
    put(s, '\n');
    s.nl++;
  }
}

function inline(s: Md, str: string, noLeadAfter = false): void {
  if (s.pendingSpace && s.nl === 0 && !s.noLead && s.started) put(s, ' ');
  s.pendingSpace = false;
  put(s, str);
  s.nl = 0;
  s.started = true;
  s.noLead = noLeadAfter;
}

function trailingNewlines(t: string): number {
  if (t.endsWith('\n\n')) return 2;
  return t.endsWith('\n') ? 1 : 0;
}

function writeText(s: Md, raw: string): void {
  if (s.inPre) {
    const t = decodeEntities(raw);
    if (!t) return;
    put(s, t);
    s.started = true;
    s.nl = trailingNewlines(t);
    return;
  }
  const spaced = decodeEntities(raw.replace(/\s+/g, ' '));
  const lead = spaced.trimStart();
  const core = lead.trimEnd();
  if (!core) {
    if (spaced) s.pendingSpace = true;
    return;
  }
  if (lead.length !== spaced.length) s.pendingSpace = true;
  inline(s, core);
  s.pendingSpace = core.length !== lead.length;
}

function handleBr(s: Md): void {
  if (!s.inPre && !s.started) return;
  if (s.inPre || s.nl < 2) {
    put(s, '\n');
    s.nl = Math.min(s.nl + 1, 2);
  }
}

function handleHr(s: Md): void {
  ensure(s, 2);
  inline(s, '---');
  ensure(s, 2);
}

function handleAnchor(s: Md, closing: boolean, attrs: string): void {
  if (closing) {
    const href = s.links.pop();
    if (href) {
      put(s, `](${urlSafe(href)})`);
      s.nl = 0;
    }
    return;
  }
  const href = attr(HREF_RE, attrs);
  const usable = href && !href.startsWith('#') && !/^(javascript|data):/i.test(href);
  s.links.push(usable ? href : null);
  if (usable) inline(s, '[', true);
}

function handleImg(s: Md, closing: boolean, attrs: string): void {
  const src = attr(SRC_RE, attrs);
  if (closing || !src || /^data:/i.test(src)) return;
  inline(s, `![${attr(ALT_RE, attrs).replace(/[[\]]/g, '')}](${urlSafe(src)})`);
}

function handleItem(s: Md, closing: boolean): void {
  ensure(s, 1);
  if (closing) return;
  const top = s.lists[s.lists.length - 1];
  if (top?.ordered) top.n++;
  const marker = top?.ordered ? `${top.n}. ` : '- ';
  inline(s, `${'  '.repeat(Math.max(0, s.lists.length - 1))}${marker}`, true);
}

function handleList(s: Md, closing: boolean, _attrs: string, tag: string): void {
  if (closing) s.lists.pop();
  ensure(s, s.lists.length ? 1 : 2);
  if (!closing) s.lists.push({ ordered: tag === 'ol', n: 0 });
}

function handlePre(s: Md, closing: boolean): void {
  if (!closing) {
    ensure(s, 2);
    put(s, '```\n');
    s.started = true;
    s.nl = 1;
    s.inPre = true;
    return;
  }
  if (!s.inPre) return;
  if (s.nl === 0) put(s, '\n');
  put(s, '```');
  s.nl = 0;
  s.inPre = false;
  ensure(s, 2);
}

function handleCode(s: Md, closing: boolean): void {
  if (s.inPre) return;
  if (closing) {
    put(s, '`');
    s.nl = 0;
  } else inline(s, '`', true);
}

function handleCell(s: Md, closing: boolean): void {
  if (closing) return;
  s.pendingSpace = false;
  if (!s.cellFirst) inline(s, ' | ');
  s.cellFirst = false;
  s.noLead = true;
}

function handleRow(s: Md): void {
  ensure(s, 1);
  s.cellFirst = true;
}

function handleHeading(s: Md, closing: boolean, _attrs: string, tag: string): void {
  ensure(s, 2);
  if (!closing) inline(s, `${'#'.repeat(tag.charCodeAt(1) - 48)} `, true);
}

const HANDLERS = new Map<string, TagHandler>([
  ['br', handleBr],
  ['hr', handleHr],
  ['a', handleAnchor],
  ['img', handleImg],
  ['li', handleItem],
  ['ul', handleList],
  ['ol', handleList],
  ['pre', handlePre],
  ['code', handleCode],
  ['td', handleCell],
  ['th', handleCell],
  ['tr', handleRow],
  ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((h): [string, TagHandler] => [h, handleHeading]),
]);

function handleTag(s: Md, closing: boolean, attrs: string, tag: string): void {
  const handler = HANDLERS.get(tag);
  if (handler) handler(s, closing, attrs, tag);
  else if (BLOCK2.has(tag)) ensure(s, 2);
  else if (BLOCK1.has(tag)) ensure(s, 1);
}

/** Index just after the matching close tag (case-insensitive linear scan), or the end of the input. */
function skipPast(src: string, tag: string, from: number): number {
  const close = new RegExp(`</${tag}\\s*>`, 'ig');
  close.lastIndex = from;
  return close.exec(src) ? close.lastIndex : src.length;
}

function walk(s: Md, src: string, limit: number): void {
  let last = 0;
  TAG_RE.lastIndex = 0;
  for (;;) {
    const m = TAG_RE.exec(src);
    if (!m) break;
    if (m.index > last) writeText(s, src.slice(last, m.index));
    last = TAG_RE.lastIndex;
    const [, slash, name = '', attrs = ''] = m;
    const tag = name.toLowerCase();
    const closing = slash === '/';
    if (!closing && SKIP_CONTENT.has(tag)) {
      if (!attrs.endsWith('/')) last = skipPast(src, tag, last);
      TAG_RE.lastIndex = last;
      continue;
    }
    handleTag(s, closing, attrs, tag);
    if (s.len >= limit) return;
  }
  if (last < src.length) writeText(s, src.slice(last));
}

function truncate(md: string, max: number): string {
  if (!max || md.length <= max) return md;
  let cut = max - 1;
  const c = md.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--;
  return `${md.slice(0, cut).trimEnd()}…`;
}

export function htmlToMarkdown(html: string | null | undefined, opts?: { maxChars?: number }): string {
  if (!html) return '';
  const max = opts?.maxChars && opts.maxChars > 0 ? opts.maxChars : 0;
  const s: Md = {
    out: [],
    len: 0,
    started: false,
    nl: 0,
    pendingSpace: false,
    noLead: false,
    inPre: false,
    cellFirst: true,
    lists: [],
    links: [],
  };
  walk(s, stripComments(html), max ? max + 64 : Number.POSITIVE_INFINITY);
  return truncate(
    s.out
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    max,
  );
}
