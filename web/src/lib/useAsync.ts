import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (fn: (prev: T | undefined) => T | undefined) => void;
}

/** Loads once on mount; `reload()` fetches again. Results from superseded calls are ignored. */
export function useAsync<T>(fn: () => Promise<T>): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const callId = useRef(0);

  const reload = useCallback(() => {
    const id = ++callId.current;
    setLoading(true);
    setError(null);
    fnRef.current().then(
      (v) => {
        if (id !== callId.current) return;
        setData(v);
        setLoading(false);
      },
      (e: unknown) => {
        if (id !== callId.current) return;
        setError(e);
        setLoading(false);
      },
    );
  }, []);

  useEffect(reload, [reload]);

  return { data, error, loading, reload, setData };
}
