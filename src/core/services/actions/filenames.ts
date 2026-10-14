/** File names, mime guesses and Moodle accepted-type matching. */

/** Drops ASCII control characters (including DEL). */
const stripControl = (s: string) =>
  Array.from(s)
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join('');

/** basename, no control chars, <= 120 chars (extension kept). Returns '' when nothing usable is left. */
export function sanitizeFileName(raw: string): string {
  const base = stripControl(raw).split(/[\\/]/).pop() ?? '';
  const name = base
    .normalize('NFC')
    .trim()
    .replace(/[<>:"|?*]/g, '_');
  if (/^\.+$/.test(name)) return '';
  if (name.length <= 120) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  return name.slice(0, 120 - ext.length) + ext;
}

const MIME_BY_EXT = new Map(
  Object.entries({
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    html: 'text/html',
    htm: 'text/html',
    json: 'application/json',
    xml: 'application/xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    py: 'text/x-python',
    ipynb: 'application/x-ipynb+json',
  }),
);

function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function guessMime(name: string): string | null {
  return MIME_BY_EXT.get(fileExt(name)) ?? null;
}

const GROUPS = new Map(
  Object.entries({
    image: ['gif', 'jpe', 'jpeg', 'jpg', 'png', 'svg', 'webp', 'bmp', 'tif', 'tiff', 'heic'],
    web_image: ['gif', 'jpe', 'jpeg', 'jpg', 'png', 'svg', 'webp'],
    document: ['doc', 'docx', 'odt', 'pdf', 'rtf', 'txt', 'pages', 'tex', 'md'],
    spreadsheet: ['xls', 'xlsx', 'ods', 'csv', 'numbers'],
    presentation: ['ppt', 'pptx', 'odp', 'key'],
    audio: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'],
    video: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'mpg', 'mpeg'],
    archive: ['zip', 'tar', 'gz', '7z', 'rar', 'tgz'],
    text: ['txt', 'csv', 'md', 'rtf', 'html', 'htm'],
    html_audio: ['mp3', 'ogg', 'wav'],
    html_video: ['mp4', 'webm', 'ogg'],
    source: ['py', 'java', 'c', 'cpp', 'h', 'js', 'ts', 'r', 'rb', 'go', 'rs', 'sql', 'ipynb'],
  }),
);

type Verdict = 'match' | 'miss' | 'unknown';

function mimeVerdict(token: string, mime: string | null): Verdict {
  if (!mime) return 'miss';
  const wildcard = token.endsWith('/*') && mime.startsWith(token.slice(0, -1));
  return token === mime || wildcard ? 'match' : 'miss';
}

function tokenVerdict(token: string, file: { ext: string; mime: string | null }): Verdict {
  if (!token || token === '*') return 'match';
  if (token.startsWith('.')) return token.slice(1) === file.ext ? 'match' : 'miss';
  if (token.includes('/')) return mimeVerdict(token, file.mime);
  const group = GROUPS.get(token);
  if (!group) return 'unknown';
  return group.includes(file.ext) ? 'match' : 'miss';
}

/**
 * Moodle accepted-types check. Empty list / '*' = anything. Unknown group tokens cannot be verified,
 * so they never cause a rejection.
 */
export function fileTypeAccepted(name: string, accepted: string[]): boolean {
  if (accepted.length === 0) return true;
  const file = { ext: fileExt(name), mime: guessMime(name) };
  const verdicts = accepted.map((t) => tokenVerdict(t.trim().toLowerCase(), file));
  return verdicts.includes('match') || verdicts.includes('unknown');
}
