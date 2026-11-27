/** Stale-while-revalidate for console answers the server may serve from its stored copy (GET /api/due). */

interface MaybeStale {
  /** true = the server answered a stored copy at once; a refreshed answer follows on request. */
  stale: boolean;
}

/**
 * The answer to show once the background refresh settled: `first` when it is already fresh, else the refreshed one.
 * A failed refresh keeps `first` (the cached list stays; nothing alarming is shown).
 */
export async function revalidate<T extends MaybeStale>(first: T, refresh: () => Promise<T>): Promise<T> {
  if (!first.stale) return first;
  try {
    return await refresh();
  } catch {
    return first;
  }
}
