/** Human-readable byte sizes, shared by the services and the MCP renderers. */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

const nameKey = (s: string) => s.replace(/[\s,.・、]+/g, '').toLowerCase();

/**
 * A Moodle full name for display. Waseda fills both name fields with the whole name in two spellings (first name
 * `SHAO, Taro`, last name `SHAO Taro`), so Moodle's `first last` reads `SHAO, Taro SHAO Taro`: when the second half
 * repeats the first (ignoring spaces, commas, dots and case), only the first half is kept. Other names are returned
 * with runs of whitespace collapsed.
 */
export function displayName(fullname: string): string {
  const name = fullname.replace(/\s+/g, ' ').trim();
  const words = name.split(' ');
  for (let i = 1; i < words.length; i++) {
    const head = words.slice(0, i).join(' ');
    if (nameKey(head) !== '' && nameKey(head) === nameKey(words.slice(i).join(' '))) return head;
  }
  return name;
}
