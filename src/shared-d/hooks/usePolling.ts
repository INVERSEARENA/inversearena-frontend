import { useEffect, useState, useRef, useCallback } from 'react';

function usePageVisibility() {
  const [isVisible, setIsVisible] = useState(!document.hidden);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsVisible(!document.hidden);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  return isVisible;
}

export type PollingStatus = 'idle' | 'loading' | 'success' | 'error';

export interface PollingOptions<T> {
  intervalMs: number;
  enabled?: boolean;
  initialData?: T;
}

export interface FetcherContext {
  signal: AbortSignal;
}

export interface UsePollingReturn<T> {
  data: T | undefined;
  error: Error | null;
  status: PollingStatus;
  refresh: () => void;
}

export function usePolling<T>(
  fetcher: (context: FetcherContext) => Promise<T>,
  options: PollingOptions<T>
): UsePollingReturn<T> {
  const { intervalMs, enabled = true, initialData } = options;

  const [data, setData] = useState<T | undefined>(initialData);
  const [error, setError] = useState<Error | null>(null);
  const [status, setStatus] = useState<PollingStatus>(initialData ? 'success' : 'idle');

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isFetchingRef = useRef(false);
  const isVisible = usePageVisibility();

  const fetchData = useCallback(async () => {
    if (isFetchingRef.current) return;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    abortControllerRef.current = new AbortController();
    isFetchingRef.current = true;
    setStatus('loading');

    try {
      const result = await fetcher({ signal: abortControllerRef.current.signal });

      if (!abortControllerRef.current.signal.aborted) {
        setData(result);
        setError(null);
        setStatus('success');
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;

      if (!abortControllerRef.current?.signal.aborted) {
        setError(err instanceof Error ? err : new Error('Unknown error'));
        setStatus('error');
      }
    } finally {
      isFetchingRef.current = false;
    }
  }, [fetcher]);

  const refresh = useCallback(() => fetchData(), [fetchData]);

  useEffect(() => {
    if (!enabled) return;

    fetchData();

    if (isVisible) {
      intervalRef.current = setInterval(fetchData, intervalMs);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [enabled, intervalMs, isVisible, fetchData]);

  useEffect(() => {
    if (!enabled) return;

    if (isVisible) {
      if (!intervalRef.current) {
        intervalRef.current = setInterval(fetchData, intervalMs);
      }
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
  }, [isVisible, enabled, intervalMs, fetchData]);

  return { data, error, status, refresh };
}
