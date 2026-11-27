/**
 * Draft uploads on the web channel: the upload repository (`repository/repository_ajax.php?action=upload`), as the
 * file picker does. Measured: it accepts only the ACTIVITY's context (`ctx_id`; user/system context ->
 * nopermissiontoaccess), so the target is read from the activity page the draft is for (once per session and cmid):
 * its M.cfg contextid and the file picker options (upload repository id, default licence). The upload repository is
 * one instance for the whole site, so when the activity page shows no file picker (a forum view without the inline
 * add-discussion form), any file picker page serves: one this session already read, else the forum's post form.
 */

import type { DraftUploadResult } from '../../context';
import { MoodleError, MoodleUnavailable } from '../../errors';
import { isObj, multipartParts, randomDraftItemId, type UploadFile, uploadBody, uploadMeta } from '../wire';
import { pageConfig } from './html';
import { type ForumView, parseForumView } from './parse/forum-view';
import type { MoodleWebSession } from './session';

/** `resend` = the sesskey was refused (the file never arrived). */
type Outcome = DraftUploadResult | { resend: true };

interface RepoTarget {
  ctxId: number;
  repoId: string;
  license: string | null;
}

const UPLOAD_TIMEOUT_MS = 120_000;
const UNEXPECTED = 'Unexpected response from the Moodle upload repository.';
const RESENT_MSG = 'The Moodle session key was renewed during the upload. Send the file again.';
const UPLOAD_REPO = /"id":"(\d+)","name":"(?:[^"\\]|\\.)*","type":"upload"/;
const LICENSE = /"defaultlicense":"([A-Za-z0-9_.-]+)"/;
const MODNAME = /\/mod\/([a-z0-9_]+)\/view\.php\?id=/;

const targets = new WeakMap<MoodleWebSession, Map<number, Promise<RepoTarget>>>();

/** The page holding the activity's file picker: the assignment's submission form, else the activity page. */
const pickerPage = (modname: string, cmid: number) =>
  modname === 'assign'
    ? `/mod/assign/view.php?id=${cmid}&action=editsubmission`
    : `/mod/${modname}/view.php?id=${cmid}`;

/** A forum's post form (it has the file picker): new discussion when the user may start one, else a reply. */
function forumFormPath(view: ForumView): string | null {
  if (view.canCreate && view.forumId) return `/mod/forum/post.php?forum=${view.forumId}`;
  const postId = view.rows.find((r) => r.latestPostId)?.latestPostId;
  return postId ? `/mod/forum/post.php?reply=${postId}` : null;
}

/** A file picker page other than the activity page (see the module comment); '' = none. */
async function otherPicker(web: MoodleWebSession, modname: string, activityHtml: string): Promise<string> {
  const seen = await web.seenPage(UPLOAD_REPO);
  if (seen) return seen.html;
  const path = modname === 'forum' ? forumFormPath(parseForumView(activityHtml)) : null;
  if (!path) return '';
  try {
    return (await web.page(path)).html;
  } catch (e) {
    if (e instanceof MoodleError) return ''; // Moodle refused the form: no right to post here
    throw e;
  }
}

async function readTarget(web: MoodleWebSession, cmid: number): Promise<RepoTarget> {
  const snippet = await web.ajax<unknown>('core_course_get_module', { id: cmid });
  const modname = MODNAME.exec(typeof snippet === 'string' ? snippet : '')?.[1];
  if (!modname) throw new MoodleError('The activity for this upload was not found.', 'invalidrecord');
  const { html } = await web.page(pickerPage(modname, cmid));
  const ctxId = pageConfig(html).contextId;
  const picker = ctxId && !UPLOAD_REPO.test(html) ? await otherPicker(web, modname, html) : html;
  const repoId = UPLOAD_REPO.exec(picker)?.[1];
  if (!ctxId || !repoId) {
    throw new MoodleError('This activity does not accept file uploads.', 'nopermissiontoaccess');
  }
  return { ctxId, repoId, license: LICENSE.exec(picker)?.[1] ?? null };
}

function targetOf(web: MoodleWebSession, cmid: number): Promise<RepoTarget> {
  let byCmid = targets.get(web);
  if (!byCmid) {
    byCmid = new Map();
    targets.set(web, byCmid);
  }
  const cache = byCmid;
  const hit = cache.get(cmid);
  if (hit) return hit;
  const p = readTarget(web, cmid);
  cache.set(cmid, p);
  p.catch(() => cache.delete(cmid));
  return p;
}

/** The repository's answer as JSON; the login page (or an ended-session code, see readAnswer) ends the session. */
async function answerJson(web: MoodleWebSession, res: Response): Promise<unknown> {
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    web.checkSignedIn(body);
    throw new MoodleUnavailable(UNEXPECTED);
  }
}

/** Reads the repository's JSON answer (repository_ajax.php is an AJAX_SCRIPT: a dead session answers in JSON). */
async function readAnswer(web: MoodleWebSession, res: Response, size: number): Promise<Outcome> {
  if (res.status === 413) throw new MoodleError('The file is too large for Moodle.', 'fileoversized');
  const rec = await answerJson(web, res);
  if (!isObj(rec)) throw new MoodleError(UNEXPECTED, 'upload_failed');
  if (rec.event === 'fileexists') {
    throw new MoodleError('A file with this name is already in the draft.', 'fileexists');
  }
  if (typeof rec.error === 'string') {
    const code = typeof rec.errorcode === 'string' && rec.errorcode ? rec.errorcode : 'upload_failed';
    web.checkSignedIn('', code);
    if (code === 'invalidsesskey') return { resend: true };
    throw new MoodleError(rec.error || 'Moodle rejected the upload.', code);
  }
  const id = Number(rec.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new MoodleError(UNEXPECTED, 'upload_failed');
  return { itemid: id, filename: typeof rec.file === 'string' ? rec.file : '', filesize: size };
}

interface Attempt {
  target: RepoTarget;
  itemId: number;
  name: string;
  mime: string;
}

async function post(web: MoodleWebSession, file: UploadFile, a: Attempt): Promise<Outcome> {
  const fields: Array<[string, string]> = [
    ['sesskey', await web.sesskey()],
    ['repo_id', a.target.repoId],
    ['itemid', String(a.itemId)],
    ['ctx_id', String(a.target.ctxId)],
    ['savepath', '/'],
    ['title', a.name],
    ['author', ''],
  ];
  if (a.target.license) fields.push(['license', a.target.license]);
  const parts = multipartParts(fields, { field: 'repo_upload_file', name: a.name, mime: a.mime });
  const { body, duplex } = await uploadBody(file, parts);
  const init = {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${parts.boundary}`, Accept: 'application/json' },
    body,
    duplex,
  };
  const url = `${web.baseUrl}/repository/repository_ajax.php?action=upload`;
  return web.sending(async () => {
    const res = await web.send(url, init, UPLOAD_TIMEOUT_MS);
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (location) {
      res.body?.cancel().catch(() => {});
      web.checkLocation(location);
      throw new MoodleUnavailable(UNEXPECTED);
    }
    const outcome = await readAnswer(web, res, file.size);
    web.acceptCookie(res);
    return outcome;
  });
}

/**
 * Streams one file into a draft area through the upload repository. itemId 0 = a new draft (a fresh random id, as
 * core_files_get_unused_draft_itemid would give). A refused sesskey is renewed and a buffered file sent once more.
 */
export async function uploadViaRepository(
  web: MoodleWebSession,
  file: UploadFile,
  opts: { itemId: number; cmid: number },
): Promise<DraftUploadResult> {
  const { name, mime } = uploadMeta(file);
  const target = await targetOf(web, opts.cmid);
  const attempt = { target, itemId: Math.trunc(opts.itemId) || randomDraftItemId(), name, mime };
  const first = await post(web, file, attempt);
  if (!('resend' in first)) return { ...first, filename: first.filename || name };
  await web.renewSesskey();
  if (!(file.body instanceof Uint8Array)) throw new MoodleUnavailable(RESENT_MSG);
  const again = await post(web, file, attempt);
  if ('resend' in again) throw new MoodleError('Moodle refused the session key.', 'invalidsesskey');
  return { ...again, filename: again.filename || name };
}
