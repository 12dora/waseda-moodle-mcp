/** Forum subscription on / off (mod_forum only; Open LMS mod_hsuforum has no web service for it). */

import type { MoodleApi, ServiceContext } from '../../context';
import { InvalidInput } from '../../errors';
import { decodeEntities } from '../../html';
import type { ActionPreview } from '../../types';
import { courseNameMap, getCourseModule } from '../shared';
import {
  type ActionOutcome,
  assertWriteAllowed,
  hasWarnings,
  isRec,
  num,
  positiveInt,
  type Raw,
  refusal,
  savePreview,
  str,
  tryCall,
} from './shared';

interface PrepareForumSubscriptionInput {
  forumCmid: number;
  subscribe: boolean;
}

type SubscriptionPayload = {
  forumId: number;
  forumName: string;
  subscribe: boolean;
  url: string;
};

/** mod_forum `forcesubscribe` values that leave no choice to the user. */
const FORCED = 1;
const DISALLOWED = 3;

/** Name and subscription mode of one forum; null when the listing does not show it (the write is still tried). */
async function forumInfo(
  api: MoodleApi,
  courseId: number,
  instance: number,
): Promise<{ name: string | null; mode: number | null } | null> {
  const list = await tryCall<unknown>(api, 'mod_forum_get_forums_by_courses', { courseids: [courseId] });
  const forum = Array.isArray(list) ? list.find((f): f is Raw => isRec(f) && num(f.id) === instance) : undefined;
  if (!forum) return null;
  const name = str(forum.name);
  return { name: name ? decodeEntities(name) : null, mode: num(forum.forcesubscribe) };
}

function assertChoosable(mode: number | null): void {
  if (mode === FORCED) {
    throw new InvalidInput('Subscription to this forum is mandatory: everyone is subscribed and cannot opt out.');
  }
  if (mode === DISALLOWED) throw new InvalidInput('Subscriptions are turned off in this forum.');
}

export async function prepareForumSubscription(
  ctx: ServiceContext,
  input: PrepareForumSubscriptionInput,
): Promise<ActionPreview> {
  assertWriteAllowed(ctx);
  const cmid = positiveInt(input.forumCmid, 'forum_cmid');
  if (typeof input.subscribe !== 'boolean') throw new InvalidInput('subscribe must be true or false.');
  const api = await ctx.moodle();
  const cm = await getCourseModule(api, cmid);
  if (cm.modname === 'hsuforum') {
    throw new InvalidInput('Subscriptions of Advanced Forums (hsuforum) cannot be changed here; use the Moodle site.');
  }
  if (cm.modname !== 'forum') throw new InvalidInput(`Activity ${cmid} is not a forum.`);
  const info = await forumInfo(api, cm.courseId, cm.instance);
  assertChoosable(info?.mode ?? null);
  const forumName = info?.name || cm.name || `forum ${cmid}`;
  const courseName = (await courseNameMap(ctx)).get(cm.courseId) ?? `course ${cm.courseId}`;
  const payload: SubscriptionPayload = {
    forumId: cm.instance,
    forumName,
    subscribe: input.subscribe,
    url: `${api.baseUrl}/mod/forum/view.php?id=${cmid}`,
  };
  return savePreview(ctx, {
    kind: 'forum_subscription',
    title: `${input.subscribe ? 'Subscribe to' : 'Unsubscribe from'} '${forumName}'`,
    details: [
      `Forum: ${forumName} (${courseName})`,
      input.subscribe ? 'New posts will be sent to you by email.' : 'You will stop receiving emails for new posts.',
    ],
    warnings: [],
    payload,
  });
}

export async function executeForumSubscription(api: MoodleApi, payload: Raw): Promise<ActionOutcome> {
  const p = payload as SubscriptionPayload;
  const res = await api.call<unknown>('mod_forum_set_forum_subscription', {
    forumid: p.forumId,
    targetstate: p.subscribe,
  });
  if (hasWarnings(res)) throw refusal('did not change the subscription', res);
  return { message: `${p.subscribe ? 'Subscribed to' : 'Unsubscribed from'} '${p.forumName}'.`, url: p.url };
}
