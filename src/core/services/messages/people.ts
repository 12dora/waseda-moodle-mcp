/**
 * People search for starting a message. Moodle's whole-site user search is far too slow on Waseda and students may not
 * list course participants, so people are found where the user can actually see them: authors of discussions in the
 * forums of their courses, and members of their conversations.
 */

import type { MoodleApi, ServiceContext } from '../../context';
import { InvalidInput, MoodleError } from '../../errors';
import { decodeEntities } from '../../html';
import { fold, scanDiscussions, searchTerms } from '../forums-search';
import type { RawConversation } from '../messages';
import { clampInt } from '../shared';

export interface Person {
  id: number;
  name: string;
  /** Names of the courses whose forums this person posted in. */
  courses: string[];
  /** Shares a conversation with the user. */
  inConversation: boolean;
  /** Started a discussion in an announcement forum (most likely a teacher). */
  announcements: boolean;
  /** Discussions and conversations the person was seen in. */
  seen: number;
}

export interface PeopleResult {
  query: string;
  people: Person[];
  /** Forums that were not scanned (cap or no permission). */
  skippedForums: number;
}

/** One appearance of a person; `course` is null for a conversation. */
interface Sighting {
  id: number;
  name: string;
  course: string | null;
  announcement: boolean;
}

const MAX_QUERY_CHARS = 100;
const MAX_CONVERSATIONS = 50;
const SELF_CONVERSATION = 3;

// ------------------------------------------------------------------ sources

function authorSighting(
  raw: { userid?: number | null; userfullname?: string | null },
  ref: { kind: string },
  courseName: string,
): Sighting | null {
  if (typeof raw.userid !== 'number') return null;
  return {
    id: raw.userid,
    name: decodeEntities(raw.userfullname ?? '').trim(),
    course: courseName,
    announcement: ref.kind === 'news',
  };
}

function memberSightings(conversation: RawConversation): Sighting[] {
  if (conversation.type === SELF_CONVERSATION) return [];
  return (conversation.members ?? []).map((m) => ({
    id: m.id,
    name: decodeEntities(m.fullname ?? '').trim(),
    course: null,
    announcement: false,
  }));
}

/** Members of the newest conversations; a conversation list that cannot be read only costs those people. */
async function conversationSightings(api: MoodleApi, selfId: number): Promise<Sighting[]> {
  try {
    const res = await api.call<{ conversations?: RawConversation[] | null }>('core_message_get_conversations', {
      userid: selfId,
      limitfrom: 0,
      limitnum: MAX_CONVERSATIONS,
    });
    return (res?.conversations ?? []).flatMap(memberSightings);
  } catch (e) {
    if (e instanceof MoodleError) return [];
    throw e;
  }
}

// ------------------------------------------------------------------ merge and rank

function record(person: Person, s: Sighting): void {
  person.seen++;
  person.name ||= s.name;
  if (s.announcement) person.announcements = true;
  if (s.course === null) person.inConversation = true;
  else if (!person.courses.includes(s.course)) person.courses.push(s.course);
}

/** One entry per user id, the user themself left out. */
function gather(sightings: Sighting[], selfId: number): Person[] {
  const byId = new Map<number, Person>();
  for (const s of sightings) {
    if (s.id === selfId) continue;
    const person = byId.get(s.id) ?? {
      id: s.id,
      name: '',
      courses: [],
      inConversation: false,
      announcements: false,
      seen: 0,
    };
    record(person, s);
    byId.set(s.id, person);
  }
  return [...byId.values()];
}

function rank(a: Person, b: Person): number {
  return Number(b.announcements) - Number(a.announcements) || b.seen - a.seen || a.name.localeCompare(b.name);
}

// ------------------------------------------------------------------ service

/**
 * People whose name contains every search word (any case, full-width forms folded; Japanese and romaji both work),
 * announcement authors first, then the most often seen. With `courseId` only that course's forums are read, which
 * leaves conversations out. Costs no more than a forum search (one call per forum, plus one for conversations).
 */
export async function searchPeople(
  ctx: ServiceContext,
  input: { query: string; courseId?: number; limit?: number },
): Promise<PeopleResult> {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query) throw new InvalidInput('The search text is empty.');
  if (query.length > MAX_QUERY_CHARS) throw new InvalidInput(`The search text is too long (max ${MAX_QUERY_CHARS}).`);
  const terms = searchTerms(query);
  const limit = clampInt(input.limit, 20, 1, 50);
  const api = await ctx.moodle();
  const selfId = ctx.user.moodleUserId;
  const [authors, members] = await Promise.all([
    scanDiscussions(ctx, api, { courseId: input.courseId, visit: authorSighting }),
    input.courseId == null ? conversationSightings(api, selfId) : [],
  ]);
  const people = gather([...authors.items, ...members], selfId)
    .filter((p) => {
      const name = fold(p.name).lower;
      return terms.every((t) => name.includes(t));
    })
    .sort(rank)
    .slice(0, limit);
  return { query, people, skippedForums: authors.skipped };
}
