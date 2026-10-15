import * as z from 'zod';

/** What every prepare_* tool returns. */
export const actionPreviewOut = z.looseObject({
  actionId: z.string(),
  kind: z.string(),
  title: z.string(),
  details: z.array(z.string()),
  warnings: z.array(z.string()),
  expiresAt: z.string(),
  approval: z.string(),
  approveUrl: z.string().nullable(),
});

/** What confirm_action and cancel_action return. */
export const actionResultOut = z.looseObject({
  actionId: z.string(),
  status: z.string(),
  message: z.string(),
  url: z.string().nullish(),
});
