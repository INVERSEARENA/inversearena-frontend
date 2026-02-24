"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_RESET_DELAY = 2000;

export function useClipboard(resetDelay: number = DEFAULT_RESET_DELAY) {
  const [isCopied, setIsCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  const safeDelay =
    Number.isFinite(resetDelay) && resetDelay >= 0
      ? resetDelay
      : DEFAULT_RESET_DELAY;

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  const copy = useCallback(
    async (text: string) => {
      if (
        typeof navigator === "undefined" ||
        !navigator.clipboard ||
        typeof navigator.clipboard.writeText !== "function"
      ) {
        if (isMountedRef.current) {
          setError("Clipboard API is unavailable.");
          setIsCopied(false);
        }
        return false;
      }

      try {
        await navigator.clipboard.writeText(text);

        if (!isMountedRef.current) return true;

        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }

        setError(null);
        setIsCopied(true);

        timeoutRef.current = setTimeout(() => {
          if (isMountedRef.current) {
            setIsCopied(false);
          }
          timeoutRef.current = null;
        }, safeDelay);

        return true;
      } catch (err) {
        if (!isMountedRef.current) return false;

        setError(
          err instanceof Error
            ? err.message
            : "Failed to copy text to clipboard.",
        );
        setIsCopied(false);
        return false;
      }
    },
    [safeDelay],
  );

  return { copy, isCopied, error };
}
