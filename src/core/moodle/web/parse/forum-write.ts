/**
 * mod_forum writes through post.php, as a browser submits them: GET the form, set the fields the web-service
 * parameters give, POST once (never retried). A saved form answers 303; a re-rendered form (200) carries the
 * validation errors.
 *   mod_forum_add_discussion         {forumid, subject, message, options[]}  → { discussionid, warnings }
 *   mod_forum_update_discussion_post {postid, subject?, message?, messageformat?, options[]} → { status, warnings }
 *   mod_forum_delete_post            {postid} → confirmation page, then its "continue" form → { status, warnings }
 */

import { InvalidInput, MoodleError } from '../../../errors';
import { queryInt } from '../html';
import type { WebPage, WebSession } from '../types';
import { formErrors } from './assign-page';
import { deleteConfirm, formBody, type PostForm, parsePostForm } from './forum-form';
import { forgetForums } from './forum-store';
import { parseDiscussionRows } from './forum-view';

type Params = Record<string, unknown>;

const FORMAT_HTML = '1';

function positiveId(v: unknown, name: string): number {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return v;
  throw new InvalidInput(`${name} must be a positive integer.`);
}

/** WS `options` ([{name, value}]) as a map. */
function optionsOf(params: Params): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const o of Array.isArray(params.options) ? params.options : []) {
    if (o && typeof o === 'object' && typeof (o as { name?: unknown }).name === 'string') {
      out.set((o as { name: string }).name, (o as { value?: unknown }).value);
    }
  }
  return out;
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

/** The options the post form has fields for: subscription checkbox, attachment draft, pin, send now. */
function applyOptions(form: PostForm, options: Map<string, unknown>): void {
  const f = form.fields;
  if (options.has('discussionsubscribe')) {
    if (truthy(options.get('discussionsubscribe'))) f.set('discussionsubscribe', '1');
    else f.delete('discussionsubscribe');
  }
  const draft = options.get('attachmentsid');
  if (typeof draft === 'number' && draft > 0) f.set('attachments', String(draft));
  if (truthy(options.get('discussionpinned')) || truthy(options.get('pinned'))) f.set('pinned', '1');
  if (truthy(options.get('mailnow'))) f.set('mailnow', '1');
}

async function loadForm(web: WebSession, path: string): Promise<PostForm> {
  const form = parsePostForm((await web.page(path)).html);
  if (!form) throw new MoodleError('Moodle did not show the post form.', 'unexpectedpage');
  return form;
}

/** A saved form redirects; a re-rendered one is a validation failure. */
function savedLocation(answer: WebPage, what: string): string {
  if (answer.status >= 300 && answer.status < 400 && answer.location) return answer.location;
  const errors = formErrors(answer.html);
  throw new MoodleError(errors.length > 0 ? errors.join(' ') : `Moodle did not ${what}.`, 'validation');
}

async function submit(web: WebSession, form: PostForm, what: string): Promise<string> {
  const body = formBody(form);
  if (!body.get('sesskey')) body.set('sesskey', await web.sesskey());
  const answer = await web.page(form.action, { method: 'POST', form: body });
  forgetForums(web);
  return savedLocation(answer, what);
}

/** The new discussion: from the redirect (`discuss.php?d=`), else the newest one with this subject in the list. */
async function newDiscussionId(web: WebSession, location: string, forumId: number, subject: string): Promise<number> {
  const direct = location.includes('discuss.php') ? queryInt(location, 'd') : null;
  if (direct) return direct;
  const rows = parseDiscussionRows((await web.page(`/mod/forum/view.php?f=${forumId}`)).html);
  const ids = rows.filter((r) => r.subject.trim() === subject.trim()).map((r) => r.discussion);
  if (ids.length > 0) return Math.max(...ids);
  throw new MoodleError(
    'The discussion was posted, but Moodle did not say where. Check the forum before posting again.',
    'unknownresult',
  );
}

export async function addDiscussion(web: WebSession, params: Params): Promise<unknown> {
  const forumId = positiveId(params.forumid, 'forumid');
  const subject = String(params.subject ?? '');
  const form = await loadForm(web, `/mod/forum/post.php?forum=${forumId}`);
  form.fields.set('subject', subject);
  form.fields.set('message[text]', String(params.message ?? ''));
  form.fields.set('message[format]', FORMAT_HTML);
  applyOptions(form, optionsOf(params));
  const group = params.groupid;
  if (typeof group === 'number' && group > 0 && form.fields.has('groupid')) form.fields.set('groupid', String(group));
  const location = await submit(web, form, 'accept the discussion');
  return { discussionid: await newDiscussionId(web, location, forumId, subject), warnings: [] };
}

export async function updateDiscussionPost(web: WebSession, params: Params): Promise<unknown> {
  const postId = positiveId(params.postid, 'postid');
  const form = await loadForm(web, `/mod/forum/post.php?edit=${postId}`);
  const subject = typeof params.subject === 'string' ? params.subject : '';
  const message = typeof params.message === 'string' ? params.message : '';
  // As the web service: empty subject / message keep the current ones.
  if (subject !== '') form.fields.set('subject', subject);
  if (message !== '') {
    form.fields.set('message[text]', message);
    form.fields.set('message[format]', String(params.messageformat ?? FORMAT_HTML));
  }
  applyOptions(form, optionsOf(params));
  await submit(web, form, 'save the post');
  return { status: true, warnings: [] };
}

export async function deletePost(web: WebSession, params: Params): Promise<unknown> {
  const postId = positiveId(params.postid, 'postid');
  const confirm = deleteConfirm((await web.page(`/mod/forum/post.php?delete=${postId}`)).html, postId);
  if (!confirm) throw new MoodleError('Moodle did not show the delete confirmation.', 'unexpectedpage');
  const body = new URLSearchParams();
  for (const [k, v] of confirm.fields) body.append(k, v);
  if (!body.get('sesskey')) body.set('sesskey', await web.sesskey());
  if (!body.get('confirm') && !confirm.action.includes('confirm=')) body.set('confirm', String(postId));
  const answer = await web.page(confirm.action, { method: 'POST', form: body });
  forgetForums(web);
  if (answer.status < 300 || answer.status >= 400) {
    throw new MoodleError('Moodle did not delete the post.', 'notdeleted');
  }
  return { status: true, warnings: [] };
}
