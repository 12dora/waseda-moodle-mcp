/** Page size for pending-approval counts; a full page means there may be more. */
export const PENDING_LIMIT = 100;

/** Display text for a pending count fetched with `PENDING_LIMIT` ("100+" when the page is full). */
export function pendingCountText(count: number): string {
  return count >= PENDING_LIMIT ? `${PENDING_LIMIT}+` : String(count);
}
