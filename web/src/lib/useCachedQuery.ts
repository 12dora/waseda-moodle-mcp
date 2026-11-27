import { useEffect, useRef, useState } from 'react';
import { revalidateInTurn } from './revalidate';
import { type AsyncState, useAsync } from './useAsync';

export interface CachedState<T> extends AsyncState<T> {
  /** A stale (stored) answer is shown while the current one is fetched in the background. */
  refreshing: boolean;
}

/**
 * A console read the server answers from its stored copy first (`Cached` endpoints): `fetch(false, key)` shows at
 * once; a stale answer is fetched again with `fetch(true, key)` in the background, one page refresh after another
 * (revalidateInTurn), and replaces the shown one on arrival. No spinner; a failed refresh keeps the copy. A `null`
 * answer (nothing to load for this key) is never refreshed. Loads again when `key` changes, like useAsync.
 */
export function useCachedQuery<T extends { stale: boolean } | null, K = undefined>(
  fetch: (refresh: boolean, key: K) => Promise<T>,
  key?: K,
): CachedState<T> {
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const state = useAsync((k: K) => fetchRef.current(false, k), key);
  const { data, setData } = state;
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!data?.stale) return;
    const shown = data;
    let current = true;
    setRefreshing(true);
    const refresh = () => fetchRef.current(true, key as K).then((next) => next ?? shown);
    revalidateInTurn(shown, refresh, () => current).then((next) => {
      if (!current) return;
      setRefreshing(false);
      if (next !== shown) setData(() => next);
    });
    return () => {
      current = false;
      setRefreshing(false);
    };
  }, [data, key, setData]);

  return { ...state, refreshing };
}
