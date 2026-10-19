import { useEffect, useState, useRef, useCallback } from 'react';
import { usePageVisibility } from './usePageVisibility';

export type PollingStatus = 'idle' | 'loading' | 'success' | 'error';

export interface PollingOptions<T> {
  intervalMs: number;
  enabled?: boolean;
  initialData?: T;
  maxIntervalMs?: number;
  jitterRatio?: number;
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

  const intervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isFetchingRef = useRef(false);
  const generationRef = useRef(0);
  const failuresRef = useRef(0);
  const isVisible = usePageVisibility();
  const maxIntervalMs = options.maxIntervalMs ?? Math.max(intervalMs, 60_000);
  const jitterRatio = options.jitterRatio ?? 0.1;

  const fetchData = useCallback(async () => {
    if (isFetchingRef.current) return;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    abortControllerRef.current = new AbortController();
    const generation = ++generationRef.current;
    const signal = abortControllerRef.current.signal;
    isFetchingRef.current = true;
    setStatus('loading');

    try {
      const result = await fetcher({ signal });

      if (!signal.aborted && generation === generationRef.current) {
        failuresRef.current = 0;
        setData(result);
        setError(null);
        setStatus('success');
      }
    } catch (err) {
      if (signal.aborted || generation !== generationRef.current) return;

      failuresRef.current += 1;
      setError(err instanceof Error ? err : new Error('Unknown error'));
      setStatus('error');
    } finally {
      if (generation === generationRef.current) isFetchingRef.current = false;
    }
  }, [fetcher]);

  const refresh = useCallback(() => fetchData(), [fetchData]);

  useEffect(() => {
    if (!enabled) return;

    const schedule = (delayMs: number): void => {
      intervalRef.current = setTimeout(async () => {
        intervalRef.current = null;
        await fetchData();
        if (enabled && isVisible) {
          const exponential = Math.min(intervalMs * 2 ** failuresRef.current, maxIntervalMs);
          const jitter = exponential * jitterRatio * (Math.random() * 2 - 1);
          schedule(Math.max(0, exponential + jitter));
        }
      }, delayMs);
    };

    if (isVisible) {
      void fetchData().then(() => {
        if (enabled && isVisible && !intervalRef.current) schedule(intervalMs);
      });
    }

    return () => {
      if (intervalRef.current) {
        clearTimeout(intervalRef.current);
        intervalRef.current = null;
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      generationRef.current += 1;
      isFetchingRef.current = false;
    };
  }, [enabled, intervalMs, isVisible, maxIntervalMs, jitterRatio, fetchData]);

  return { data, error, status, refresh };
}
