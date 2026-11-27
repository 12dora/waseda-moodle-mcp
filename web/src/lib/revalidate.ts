/** Stale-while-revalidate for console answers the server may serve from its stored copy (`Cached` reads). */

interface MaybeStale {
  /** true = the server answered a stored copy at once; a refreshed answer follows on request. */
  stale: boolean;
}

/**
 * The answer to show once the background refresh settled: `first` when it is already fresh, else the refreshed one.
 * A failed refresh keeps `first` (the stored copy stays; nothing alarming is shown).
 */
export async function revalidate<T extends MaybeStale>(first: T, refresh: () => Promise<T>): Promise<T> {
  if (!first.stale) return first;
  try {
    return await refresh();
  } catch {
    return first;
  }
}

/** The background refreshes waiting or running, as one chain (revalidate never rejects, so neither does the chain). */
let tail: Promise<unknown> = Promise.resolve();

/**
 * `revalidate`, one refresh after another: one Moodle web session serialises its requests, so the cards of a page
 * refreshing at once would only queue up at Moodle and delay each other. `wanted()` is asked when the refresh's turn
 * comes: false (the card went away, its key changed) skips it and keeps `first`.
 */
export function revalidateInTurn<T extends MaybeStale>(
  first: T,
  refresh: () => Promise<T>,
  wanted: () => boolean,
): Promise<T> {
  if (!first.stale) return Promise.resolve(first);
  const turn = tail.then(() => (wanted() ? revalidate(first, refresh) : first));
  tail = turn;
  return turn;
}
