import { useCallback, useEffect, useRef, useState } from 'react';

import { classifyFetchError, PanelError } from '../api/errors';

export interface Resource<T> {
  data: T | undefined;
  error: PanelError | undefined;
  loading: boolean;
  reload(): void;
}

// Answers stay cached per panel and query while the app runs, so going back to a list shows it
// at once; it is refreshed in the background every time a screen opens it.
const cache = new Map<string, unknown>();

export function clearResourceCache(): void {
  cache.clear();
}

/** Loads `load(api)` for an API client (Client or Application API); null waits for a key. */
export function useResource<A extends { origin: string }, T>(api: A | null, key: string, load: (api: A) => Promise<T>): Resource<T> {
  const cacheKey = api ? `${api.origin}|${key}` : '';
  const [data, setData] = useState<T | undefined>(() => (cacheKey ? (cache.get(cacheKey) as T | undefined) : undefined));
  const [error, setError] = useState<PanelError | undefined>();
  const [loading, setLoading] = useState(false);
  const [round, setRound] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!api) return undefined;
    let cancelled = false;
    setData(cache.get(cacheKey) as T | undefined);
    setLoading(true);
    setError(undefined);
    loadRef
      .current(api)
      .then((value) => {
        if (cancelled) return;
        cache.set(cacheKey, value);
        setData(value);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof PanelError ? reason : classifyFetchError(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, cacheKey, round]);

  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { data, error, loading, reload };
}
