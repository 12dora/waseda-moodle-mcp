import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (fn: (prev: T | undefined) => T | undefined) => void;
}

/**
 * Loads on mount and whenever `key` changes (passed to `fn`); `reload()` fetches again.
 * Results from superseded calls are ignored.
 */
export function useAsync<T, K = undefined>(fn: (key: K) => Promise<T>, key?: K): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const keyRef = useRef(key);
  keyRef.current = key;
  const callId = useRef(0);

  const run = useCallback((k: K | undefined) => {
    const id = ++callId.current;
    setLoading(true);
    setError(null);
    fnRef.current(k as K).then(
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

  const reload = useCallback(() => run(keyRef.current), [run]);

  useEffect(() => run(key), [run, key]);

  return { data, error, loading, reload, setData };
}
