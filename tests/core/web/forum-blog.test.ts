import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseForumView } from '../../../src/core/moodle/web/parse/forum-view';

const html = readFileSync(new URL('../../fixtures/web/forum-blog-ja.html', import.meta.url), 'utf8');

describe('blog-like forum view', () => {
  it('lists each discussion from its first post, with the reply count after the discuss link', () => {
    const view = parseForumView(html);
    expect(view).toMatchObject({ type: 'blog', forumId: 7110, cmid: 7010, canCreate: true });
    expect(view.rows).toEqual([
      expect.objectContaining({
        discussion: 5101,
        subject: '議事録 第3回',
        author: '山田 太郎',
        authorId: 4243,
        created: Date.parse('2026-11-20T10:15:00+09:00') / 1000,
        replies: 2,
        latestPostId: null,
      }),
      expect.objectContaining({ discussion: 5102, subject: '企画案', authorId: 4242, replies: 0, latestPostId: 9305 }),
    ]);
  });
});
