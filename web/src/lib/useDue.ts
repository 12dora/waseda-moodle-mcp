import { useEffect, useState } from 'react';
import { getDue } from '../api/endpoints';
import type { ConsoleDueList } from '../api/types';
import { revalidate } from './revalidate';
import { type AsyncState, useAsync } from './useAsync';

interface DueState extends AsyncState<ConsoleDueList> {
  /** A stale (stored) list is shown while the current one is computed in the background. */
  refreshing: boolean;
}

/**
 * The due list of the next `days` days: the server's stored copy shows at once; when it is stale the list is fetched
 * again with refresh in the background and replaces it on arrival (no spinner; a failed refresh keeps the copy).
 */
export function useDue(days: number): DueState {
  const due = useAsync(() => getDue(days));
  const { data, setData } = due;
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!data?.stale) return;
    let current = true;
    setRefreshing(true);
    revalidate(data, () => getDue(days, true)).then((next) => {
      if (!current) return;
      setRefreshing(false);
      if (next !== data) setData(() => next);
    });
    return () => {
      current = false;
      setRefreshing(false);
    };
  }, [data, days, setData]);

  return { ...due, refreshing };
}
