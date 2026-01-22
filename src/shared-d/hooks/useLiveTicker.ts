import { useEffect, useState, useRef, useCallback } from 'react';

// Hook for page visibility to pause updates when tab is hidden
function usePageVisibility() {
  const [isVisible, setIsVisible] = useState(!document.hidden);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsVisible(!document.hidden);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return isVisible;
}

// Types for the hooks
interface UseLiveTickerNumberOptions {
  start: number;
  step: number;
  intervalMs: number;
  max?: number;
}

interface UseLiveTickerListOptions<T> {
  items: T[];
  intervalMs: number;
}

interface UseLiveTickerListReturn<T> {
  currentItem: T;
  index: number;
}

// Hook for number ticking
export function useLiveTickerNumber({ start, step, intervalMs, max }: UseLiveTickerNumberOptions): number {
  const [value, setValue] = useState(start);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const isVisible = usePageVisibility();

  const tick = useCallback(() => {
    setValue((prev) => {
      const nextValue = prev + step;
      if (max !== undefined && nextValue >= max) {
        return max;
      }
      return nextValue;
    });
  }, [step, max]);

  useEffect(() => {
    if (isVisible) {
      intervalRef.current = setInterval(tick, intervalMs);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [tick, intervalMs, isVisible]);

  // Stop ticking when max is reached
  useEffect(() => {
    if (max !== undefined && value >= max) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
  }, [value, max]);

  return value;
}

// Hook for list/feed ticking
export function useLiveTickerList<T>({ items, intervalMs }: UseLiveTickerListOptions<T>): UseLiveTickerListReturn<T> {
  const [index, setIndex] = useState(0);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const isVisible = usePageVisibility();

  const tick = useCallback(() => {
    setIndex((prevIndex) => (prevIndex + 1) % items.length);
  }, [items.length]);

  useEffect(() => {
    if (isVisible && items.length > 1) {
      intervalRef.current = setInterval(tick, intervalMs);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [tick, intervalMs, isVisible, items.length]);

  // Reset index if items change
  useEffect(() => {
    if (index >= items.length) {
      setIndex(0);
    }
  }, [items.length, index]);

  return {
    currentItem: items[index] || items[0],
    index
  };
}

// Combined export for convenience
export const useLiveTicker = {
  number: useLiveTickerNumber,
  list: useLiveTickerList
};