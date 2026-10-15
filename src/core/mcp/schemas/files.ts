import * as z from 'zod';

/** The inline payload travels in `content`; structuredContent only says that it was attached. */
export const fileLinkOut = z.looseObject({
  name: z.string(),
  mime: z.string().nullable(),
  size: z.number().nullable(),
  downloadUrl: z.string(),
  expiresAt: z.string(),
  inline: z.looseObject({ mime: z.string(), attached: z.boolean() }).nullable(),
});

export const uploadLinkOut = z.looseObject({
  uploadId: z.string(),
  uploadUrl: z.string(),
  draftItemId: z.number(),
  expiresAt: z.string(),
  maxBytes: z.number(),
  curlExample: z.string(),
});
