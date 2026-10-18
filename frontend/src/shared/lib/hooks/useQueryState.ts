"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useCallback, useMemo } from "react";

export interface UseQueryStateOptions<T> {
  defaultValue: T;
  serialize?: (value: T) => string;
  deserialize?: (value: string) => T;
}

/**
 * Hook to sync state with URL query parameters
 * 
 * @param key - The query parameter key
 * @param options - Configuration options
 * @returns [value, setValue] tuple similar to useState
 * 
 * @example
 * const [filter, setFilter] = useQueryState("filter", { defaultValue: "all" });
 */
export function useQueryState<T extends string>(
  key: string,
  options: UseQueryStateOptions<T>
): [T, (value: T | null) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const { defaultValue, serialize, deserialize } = options;

  // Read current value from URL or use default
  const value = useMemo(() => {
    const paramValue = searchParams.get(key);
    
    if (paramValue === null) {
      return defaultValue;
    }

    if (deserialize) {
      return deserialize(paramValue);
    }

    return paramValue as T;
  }, [searchParams, key, defaultValue, deserialize]);

  // Update URL with new value
  const setValue = useCallback(
    (newValue: T | null) => {
      const params = new URLSearchParams(searchParams.toString());

      if (newValue === null || newValue === defaultValue) {
        // Remove param if value is null or default
        params.delete(key);
      } else {
        // Set param with serialized value
        const serializedValue = serialize ? serialize(newValue) : newValue;
        params.set(key, serializedValue);
      }

      // Use replace to avoid polluting browser history
      const newUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname;
      router.replace(newUrl, { scroll: false });
    },
    [router, pathname, searchParams, key, defaultValue, serialize]
  );

  return [value, setValue];
}
