import type { ContentBlock } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { createFileLink, createUploadLink } from '../../services/files';
import type { FileLink } from '../../types';
import { renderFileLink, renderUploadLink } from '../render/files';
import { fileLinkOut, uploadLinkOut } from '../schemas/files';
import { getFileDescription } from '../wording';
import { defineTool, id, PREPARE_HINTS, READ_HINTS } from './define';

/** Image types MCP clients and models reliably render; every other image goes out as a binary resource. */
const IMAGE_BLOCK_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

type Inline = NonNullable<FileLink['inline']>;

function inlineBlock(link: FileLink, inl: Inline): ContentBlock {
  if ('text' in inl) {
    return { type: 'resource', resource: { uri: link.downloadUrl, mimeType: inl.mime, text: inl.text } };
  }
  if (IMAGE_BLOCK_MIMES.has(inl.mime)) return { type: 'image', data: inl.base64, mimeType: inl.mime };
  return { type: 'resource', resource: { uri: link.downloadUrl, mimeType: inl.mime, blob: inl.base64 } };
}

/** resource_link first, then the inline payload (text, image or binary resource) when it was requested. */
function fileContent(link: FileLink, stdio: boolean): ContentBlock[] {
  const blocks: ContentBlock[] = [
    {
      type: 'resource_link',
      uri: link.downloadUrl,
      name: link.name,
      ...(link.mime ? { mimeType: link.mime } : {}),
      ...(link.size !== null ? { size: link.size } : {}),
      description: stdio ? 'Local copy of the file' : 'Short-lived download link',
    },
  ];
  if (link.inline) blocks.push(inlineBlock(link, link.inline));
  return blocks;
}

export const getFileTool = (stdio: boolean) =>
  defineTool({
    name: 'get_file',
    title: 'Get a Moodle file',
    description: getFileDescription(stdio ? 'stdio' : 'worker'),
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
    output: fileLinkOut,
    async run(ctx, a) {
      const link = await createFileLink(ctx, a.url, { inline: a.inline });
      // the inline payload already travels in `content`; do not duplicate it in structuredContent
      const data = { ...link, inline: link.inline ? { mime: link.inline.mime, attached: true } : null };
      return { text: renderFileLink(link, stdio), data, extra: fileContent(link, stdio) };
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
  output: uploadLinkOut,
  async run(ctx, a) {
    const r = await createUploadLink(ctx, a.cmid);
    return { text: renderUploadLink(r, a.cmid), data: r };
  },
});
