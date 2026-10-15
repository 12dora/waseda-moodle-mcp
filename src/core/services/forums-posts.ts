/** Posts of one forum discussion (mod_forum and Open LMS mod_hsuforum), mapped to the shared Post shape. */

import type { MoodleApi } from '../context';
import { MoodleError, NotFound } from '../errors';
import { decodeEntities, htmlToMarkdown } from '../html';
import { fromTs } from '../time';
import type { IsoJst, Post } from '../types';
import type { ForumType } from './forums';
import { mapFiles, type RawFile } from './shared';

// ------------------------------------------------------------------ raw Moodle shapes (loose)

interface RawForumPost {
  id: number;
  subject?: string | null;
  message?: string | null;
  author?: { id?: number | null; fullname?: string | null } | null;
  hasparent?: boolean | null;
  parentid?: number | null;
  timecreated?: number | null;
  timemodified?: number | null;
  unread?: boolean | null;
  attachments?: RawFile[] | null;
  capabilities?: { reply?: boolean | null } | null;
}

export interface RawForumPosts {
  posts?: RawForumPost[] | null;
  forumid?: number | null;
  courseid?: number | null;
}

interface RawHsuPost {
  id: number;
  parent?: number | null;
  created?: number | null;
  modified?: number | null;
  subject?: string | null;
  message?: string | null;
  userfullname?: string | null;
  attachments?: RawFile[] | null;
  postread?: boolean | null;
  canreply?: boolean | null;
}

export interface RawHsuPosts {
  posts?: RawHsuPost[] | null;
}

// ------------------------------------------------------------------ discussion posts

const POST_MAX_CHARS = 12_000;

interface NormPost {
  id: number;
  parentId: number | null;
  author: string | null | undefined;
  created: number | null | undefined;
  modified: number | null | undefined;
  subject: string | null | undefined;
  message: string | null | undefined;
  attachments: RawFile[] | null | undefined;
  unread: boolean;
}

export interface MappedPosts {
  posts: Post[];
  canReply: boolean;
  modified: IsoJst | null; // newest post modification
  unread: number | null;
}

function buildPosts(list: NormPost[], canReply: boolean): MappedPosts {
  const latest = Math.max(0, ...list.map((p) => Math.max(p.modified ?? 0, p.created ?? 0)));
  const posts = list.map(
    (p): Post => ({
      id: p.id,
      parentId: p.parentId,
      author: decodeEntities(p.author ?? ''),
      createdAt: fromTs(p.created),
      subject: decodeEntities(p.subject ?? ''),
      message: htmlToMarkdown(p.message, { maxChars: POST_MAX_CHARS }),
      attachments: mapFiles(p.attachments),
    }),
  );
  return { posts, canReply, modified: fromTs(latest), unread: list.filter((p) => p.unread).length };
}

function mapForumPosts(raw: RawForumPosts): MappedPosts {
  const list = raw.posts ?? [];
  const norm = list.map(
    (p): NormPost => ({
      id: p.id,
      parentId: p.hasparent === false ? null : (p.parentid ?? null),
      author: p.author?.fullname,
      created: p.timecreated,
      modified: p.timemodified,
      subject: p.subject,
      message: p.message,
      attachments: p.attachments,
      unread: p.unread === true,
    }),
  );
  return buildPosts(norm, list[0]?.capabilities?.reply === true);
}

function mapHsuforumPosts(raw: RawHsuPosts): MappedPosts {
  const list = [...(raw.posts ?? [])].sort((a, b) => (a.created ?? 0) - (b.created ?? 0) || a.id - b.id);
  const norm = list.map(
    (p): NormPost => ({
      id: p.id,
      parentId: p.parent ? p.parent : null,
      author: p.userfullname,
      created: p.created,
      modified: p.modified,
      subject: p.subject,
      message: p.message,
      attachments: p.attachments,
      unread: p.postread === false,
    }),
  );
  return buildPosts(norm, list[0]?.canreply === true);
}

interface LoadedPosts {
  mapped: MappedPosts;
  forumId?: number;
  courseId?: number;
}

export async function loadPosts(api: MoodleApi, forumType: ForumType, discussionId: number): Promise<LoadedPosts> {
  try {
    if (forumType === 'forum') {
      const res = await api.call<RawForumPosts>('mod_forum_get_discussion_posts', {
        discussionid: discussionId,
        sortby: 'created',
        sortdirection: 'ASC',
      });
      return {
        mapped: mapForumPosts(res ?? {}),
        forumId: res?.forumid ?? undefined,
        courseId: res?.courseid ?? undefined,
      };
    }
    const res = await api.call<RawHsuPosts>('mod_hsuforum_get_forum_discussion_posts', { discussionid: discussionId });
    return { mapped: mapHsuforumPosts(res ?? {}) };
  } catch (e) {
    if (e instanceof MoodleError) {
      throw new NotFound(`Discussion ${discussionId} was not found or is not accessible (${e.message}).`);
    }
    throw e;
  }
}
