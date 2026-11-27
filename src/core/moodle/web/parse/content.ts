/**
 * Parsers for the simple content modules on the web channel: the page, URL, resource and folder view pages, and the
 * module list of the course state (`core_courseformat_get_state`). Everything is located by classes, ids, data
 * attributes and link targets, so the interface language does not matter.
 */

import { MoodleError } from '../../../errors';
import { attr, type ElementQuery, findAll, findFirst, links, mainRegion, text } from '../html';

const byClass = (word: string, tag?: string): ElementQuery => ({ attr: 'class', value: word, word: true, tag });

/** The content of the `.no-overflow` box Moodle wraps formatted text in, when `html` starts with one. */
function unwrap(html: string): string {
  const box = findFirst(html, byClass('no-overflow'));
  return box && html.slice(0, box.start).trim() === '' ? box.inner.trim() : html.trim();
}

/**
 * An activity view page: its name, the intro of the activity header, and `body`, the main region after that header
 * (so that nothing inside the intro is mistaken for the activity's own content).
 */
export function parseModuleView(html: string) {
  const region = mainRegion(html);
  const header = findFirst(region, { attr: 'data-for', value: 'page-activity-header' });
  const intro = header ? findFirst(header.inner, byClass('activity-description')) : null;
  const info = header ? findFirst(header.inner, { attr: 'data-region', value: 'activity-information' }) : null;
  const named = info ? attr(info.attrs, 'data-activityname') : '';
  const name = named || text(findFirst(html, byClass('h2', 'h1'))?.inner ?? '');
  return {
    name: name || undefined,
    intro: intro ? unwrap(intro.inner) : '',
    body: header ? region.slice(header.start + header.outer.length) : region,
  };
}

/** The HTML of a page module's content box, or null when the page shows none. */
export function parsePageContent(body: string): string | null {
  const box = findFirst(body, byClass('generalbox'));
  return box ? unwrap(box.inner) : null;
}

/** Where a URL module points: the "click to open" link, or the source of the embedded object. */
export function parseUrlTarget(body: string): string | null {
  const workaround = findFirst(body, byClass('urlworkaround'));
  if (workaround) return links(workaround.inner)[0] ?? null;
  const embed = findFirst(body, { attr: 'id', value: 'resourceobject' }) ?? findFirst(body, byClass('resourceimage'));
  return embed ? attr(embed.attrs, 'data') || attr(embed.attrs, 'src') || null : null;
}

/** Every link, source and object target in `html` (how resource pages refer to their file in each display mode). */
export function referencedUrls(html: string): string[] {
  return ['href', 'src', 'data'].flatMap((name) => findAll(html, { attr: name }).map((el) => attr(el.attrs, name)));
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** A `contents[]` entry of core_course_get_contents; size, type and time are not on the pages (0 / ''). */
function fileEntry(url: URL, tail: string) {
  const dirs = tail.split('/').map(decodeSegment);
  const filename = dirs.pop() ?? '';
  return {
    type: 'file',
    filename,
    filepath: dirs.length > 0 ? `/${dirs.join('/')}/` : '/',
    filesize: 0,
    fileurl: url.href,
    mimetype: '',
    timemodified: 0,
  };
}

/**
 * The `urls` that are files of a module's content area (`pluginfile.php/<ctx>/<component>/content/<rev>/<path>`) on
 * this Moodle, once each. Intro images and foreign links do not match.
 */
export function moduleFiles(urls: string[], baseUrl: string, component: 'mod_resource' | 'mod_folder') {
  const origin = new URL(baseUrl).origin;
  const area = new RegExp(`/pluginfile\\.php/\\d+/${component}/content/\\d+/(.+)$`);
  const files = new Map<string, ReturnType<typeof fileEntry>>();
  for (const raw of urls) {
    const url = URL.canParse(raw, baseUrl) ? new URL(raw, baseUrl) : null;
    const tail = url?.origin === origin ? area.exec(url.pathname)?.[1] : undefined;
    if (url && tail && !files.has(url.pathname)) files.set(url.pathname, fileEntry(url, tail));
  }
  return [...files.values()];
}

interface StateModule {
  id?: string | number;
  name?: string;
  module?: string;
  uservisible?: boolean;
}

/** The visible modules of one type in the JSON string `core_courseformat_get_state` answers with. */
export function stateModules(state: string, modname: string): Array<{ cmid: number; name: string }> {
  let modules: StateModule[];
  try {
    modules = (JSON.parse(state) as { cm?: StateModule[] }).cm ?? [];
  } catch {
    throw new MoodleError('The course structure could not be read.', 'unreadablepage');
  }
  return modules
    .filter((m) => m.module === modname && m.uservisible !== false)
    .map((m) => ({ cmid: Number(m.id), name: m.name ?? '' }));
}
