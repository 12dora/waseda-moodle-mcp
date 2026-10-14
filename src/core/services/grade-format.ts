import { decodeEntities } from '../html';

/** Moodle uses '-' / '' / &nbsp; for "no value". */
export function cleanDisplay(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = decodeEntities(s)
    .replace(/\u00a0/g, ' ')
    .trim();
  return t === '' || t === '-' || t === '－' || t === '–' ? null : t;
}
