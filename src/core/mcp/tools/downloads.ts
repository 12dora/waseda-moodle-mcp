import * as z from 'zod';
import { DOWNLOAD_KINDS, downloadCourseFiles } from '../../services/downloads';
import { blockedLinkHint } from '../render/common';
import { renderCourseDownloadLinks, renderCourseDownloadLocal } from '../render/downloads';
import { list } from '../schemas/common';
import { defineTool, id, READ_HINTS } from './define';

const courseDownloadOut = z.looseObject({
  courseId: z.number(),
  section: z.number().nullable(),
  kinds: z.array(z.string()),
  files: list({ path: z.string(), cmid: z.number(), url: z.string().nullable(), localPath: z.string().nullable() }),
  failures: list({ cmid: z.number(), reason: z.string() }),
  viewed: z.looseObject({}),
  activitiesRead: z.number(),
  remaining: z.number(),
  nextCursor: z.number().nullable(),
  expiresAt: z.string().nullable(),
  directory: z.string().nullable(),
});

const linkInput = z.object({
  course_id: id('Course id (see list_courses).'),
  section: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .describe('Only this section number (0 is the general section at the top). Default: the whole course.')
    .optional(),
  kinds: z
    .array(z.enum(DOWNLOAD_KINDS))
    .min(1)
    .max(4)
    .describe('Which activities: resource, folder, page, assign (instruction files). Default resource and folder.')
    .optional(),
  cursor: id('next_cursor from the previous result (continue where it stopped; keep the other inputs).').optional(),
});

const localInput = linkInput.extend({
  dest_dir: z
    .string()
    .min(1)
    .describe(
      'Absolute path of an existing directory to create the download folder in (default: the temp directory). With cursor: the folder the previous call returned, to add the rest to it.',
    )
    .optional(),
});

const HOW = {
  worker:
    'Lists the files of a course (or one section) with short-lived download links (single-user, about 15 minutes) and a ready-to-run shell snippet (curl, one directory per section) to fetch them all at once; if your sandbox blocks the links (HTTP 403), the result says what the user must allow. ',
  stdio:
    'Downloads the files of a course (or one section) into a NEW local directory (in the temp directory or under dest_dir), one sub-directory per section, and returns the local paths. Files over 50 MB are not downloaded; the result gives their Moodle address instead. ',
};

const description = (stdio: boolean) =>
  (stdio ? HOW.stdio : HOW.worker) +
  'Default kinds: resource (single files) and folder; add page and assign for the files of pages and assignment instructions. ' +
  "On the Moodle web session, finding a resource's file opens its page, which Moodle counts as viewing it (marks it viewed, and done where completion is on viewing); pages and assignments are read through their pages too, and downloading a folder's ZIP counts as viewing the folder. The result says how many were opened. " +
  'Large courses come in chunks (about 30 activity pages per call): call again with next_cursor until nothing remains.';

export const downloadCourseFilesTool = (stdio: boolean) =>
  defineTool({
    name: 'download_course_files',
    title: 'Download course files',
    description: description(stdio),
    annotations: READ_HINTS,
    input: stdio ? localInput : linkInput,
    output: courseDownloadOut,
    async run(ctx, a) {
      const destDir = 'dest_dir' in a && typeof a.dest_dir === 'string' ? a.dest_dir : undefined;
      const r = await downloadCourseFiles(ctx, a.course_id, {
        section: a.section,
        kinds: a.kinds,
        cursor: a.cursor,
        destDir,
      });
      if (stdio) return { text: renderCourseDownloadLocal(r), data: r };
      const url = r.files.find((f) => f.url)?.url;
      return { text: renderCourseDownloadLinks(r), data: { ...r, ifBlocked: url ? blockedLinkHint(url) : null } };
    },
  });
