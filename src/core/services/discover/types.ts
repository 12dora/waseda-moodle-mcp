/** Result shapes of the discovery tools (list_incomplete, list_my_posts, search_courses). */

import type { IsoJst } from '../../types';

// ------------------------------------------------------------------ list_incomplete

export interface IncompleteActivity {
  cmid: number;
  name: string;
  /** Moodle module name: resource, quiz, assign, page, millvi (on-demand video), ... */
  kind: string;
  url: string | null;
  sectionNumber: number;
  sectionName: string;
  /** How Moodle completes it: the student marks it, or it completes by itself when the conditions are met. */
  completion: 'manual' | 'automatic' | 'unknown';
  /** Conditions still to meet as the course page words them (e.g. "View", "Submit"); empty when Moodle shows none. */
  conditions: string[];
  /** Hidden from the student view or not yet available (only listed with include_hidden). */
  hidden: boolean;
}

export interface IncompleteCourse {
  courseId: number;
  courseName: string;
  /** Activities with completion tracking that are done / all of them (after the kinds filter). */
  done: number;
  total: number;
  activities: IncompleteActivity[];
}

export interface SkippedCourse {
  courseId: number;
  courseName: string;
  reason: 'budget' | 'unreadable';
}

export interface IncompleteList {
  courses: IncompleteCourse[];
  skippedCourses: SkippedCourse[];
  /** The kinds filter that was applied; null = every kind. */
  kinds: string[] | null;
}

// ------------------------------------------------------------------ list_my_posts

export interface MyPost {
  postId: number;
  discussionId: number;
  courseId: number | null;
  courseName: string;
  forumType: 'forum' | 'hsuforum';
  forumCmid: number | null;
  forumName: string;
  discussionSubject: string;
  postSubject: string;
  postedAt: IsoJst | null;
  /** true = the post started its discussion, false = a reply to `parentPostId`. */
  isDiscussionStart: boolean;
  parentPostId: number | null;
  /** The page does not show reply counts; always null (kept so callers need not guess). */
  replies: number | null;
  excerpt: string;
  url: string;
}

export interface MyPostsList {
  posts: MyPost[];
  page: number;
  /** Next page number to pass, null on the last page. */
  nextPage: number | null;
}

// ------------------------------------------------------------------ search_courses

export interface FoundCourse {
  id: number;
  name: string;
  shortName: string;
  category: string | null;
  url: string;
  enrolled: boolean;
}

export interface CourseSearchResult {
  query: string;
  courses: FoundCourse[];
  total: number;
  page: number;
  pageSize: number;
  /** Next page number to pass, null when this page reaches the end. */
  nextPage: number | null;
}
