import type { ContentBlock } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { createFileLink, createUploadLink } from '../../services/files';
import type { FileLink } from '../../types';
import { renderFileLink, renderUploadLink } from '../render/files';
import { defineTool, id, PREPARE_HINTS, READ_HINTS } from './define';

/** resource_link first, then the inline payload (text, image or binary resource) when it was requested. */
function fileContent(link: FileLink): ContentBlock[] {
  const blocks: ContentBlock[] = [
    {
      type: 'resource_link',
      uri: link.downloadUrl,
      name: link.name,
      ...(link.mime ? { mimeType: link.mime } : {}),
      ...(link.size !== null ? { size: link.size } : {}),
      description: 'Short-lived download link',
    },
  ];
  const inl = link.inline;
  if (!inl) return blocks;
  if ('text' in inl) {
    blocks.push({ type: 'resource', resource: { uri: link.downloadUrl, mimeType: inl.mime, text: inl.text } });
  } else if (inl.mime.startsWith('image/')) {
    blocks.push({ type: 'image', data: inl.base64, mimeType: inl.mime });
  } else {
    blocks.push({ type: 'resource', resource: { uri: link.downloadUrl, mimeType: inl.mime, blob: inl.base64 } });
  }
  return blocks;
}

export const getFileTool = defineTool({
  name: 'get_file',
  title: 'Get a Moodle file',
  description:
    'Creates a short-lived download link for a Moodle file (slides, PDFs, assignment attachments, submitted files, forum attachments). ' +
    'Pass the file url exactly as listed by get_activity or other tools; download the link with your own tools (e.g. curl) and read the file locally. ' +
    'With inline=true, small files (up to 1 MiB) are also attached directly: text as text, images and PDFs as binary content.',
  annotations: READ_HINTS,
  input: z.object({
    url: z
      .string()
      .min(1)
      .describe('Moodle file URL as returned by the other tools (pluginfile URL, without a token).'),
    inline: z
      .boolean()
      .describe('Also attach the content to the result when the file is small (<= 1 MiB). Default false.')
      .optional(),
  }),
  async run(ctx, a) {
    const link = await createFileLink(ctx, a.url, { inline: a.inline });
    // the inline payload already travels in `content`; do not duplicate it in structuredContent
    const data = { ...link, inline: link.inline ? { mime: link.inline.mime, attached: true } : null };
    return { text: renderFileLink(link), data, extra: fileContent(link) };
  },
});

export const createUploadLinkTool = defineTool({
  name: 'create_upload_link',
  title: 'Create upload link',
  description:
    'Creates a short-lived upload link for a file that should be part of an assignment submission, for files too large to pass inline. ' +
    'Upload the file with curl (PUT raw bytes, name in ?name=), then call prepare_submission with the returned upload_id. ' +
    "This does not submit anything; submitting still needs prepare_submission and the user's confirmation.",
  annotations: PREPARE_HINTS,
  input: z.object({ cmid: id('Assignment cmid (see get_activity); it must accept file submissions.') }),
  async run(ctx, a) {
    const r = await createUploadLink(ctx, a.cmid);
    return { text: renderUploadLink(r, a.cmid), data: r };
  },
});
