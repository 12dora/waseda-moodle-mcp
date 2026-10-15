import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (fn: (prev: T | undefined) => T | undefined) => void;
}

/** A value together with the key it was loaded for, so a key change never shows the previous key's result. */
interface Keyed<K, V> {
  key: K | undefined;
  value: V;
}

const forKey = <K, V>(entry: Keyed<K, V> | null, key: K | undefined): V | undefined =>
  entry && Object.is(entry.key, key) ? entry.value : undefined;

/**
 * Loads on mount and whenever `key` changes (passed to `fn`); `reload()` fetches again.
 * Results from superseded calls are ignored; data and errors loaded for another key are not returned.
 */
export function useAsync<T, K = undefined>(fn: (key: K) => Promise<T>, key?: K): AsyncState<T> {
  const [data, setEntry] = useState<Keyed<K, T> | null>(null);
  const [error, setError] = useState<Keyed<K, unknown> | null>(null);
  const [loadingKey, setLoadingKey] = useState<Keyed<K, boolean>>({ key, value: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const keyRef = useRef(key);
  keyRef.current = key;
  const callId = useRef(0);

  const run = useCallback((k: K | undefined) => {
    const id = ++callId.current;
    setLoadingKey({ key: k, value: true });
    setError(null);
    fnRef.current(k as K).then(
      (v) => {
        if (id !== callId.current) return;
        setEntry({ key: k, value: v });
        setLoadingKey({ key: k, value: false });
      },
      (e: unknown) => {
        if (id !== callId.current) return;
        setError({ key: k, value: e });
        setLoadingKey({ key: k, value: false });
      },
    );
  }, []);

  const reload = useCallback(() => run(keyRef.current), [run]);

  const setData = useCallback((update: (prev: T | undefined) => T | undefined) => {
    setEntry((prev) => {
      const next = update(forKey(prev, keyRef.current));
      return next === undefined ? null : { key: keyRef.current, value: next };
    });
  }, []);

  useEffect(() => run(key), [run, key]);

  return {
    data: forKey(data, key),
    error: forKey(error, key) ?? null,
    // A key that has not started loading yet counts as loading.
    loading: forKey(loadingKey, key) ?? true,
    reload,
    setData,
  };
}
