import { useCallback, useEffect, useRef, useState } from "react";
import { fetchServerTimeOffsetMs } from "../services/serverTimeClient";
import { usePageVisibility } from "./usePageVisibility";

/** Re-fetch the offset this often while the tab is visible, to catch clock drift. */
const REFRESH_INTERVAL_MS = 60_000;

export interface UseServerTimeSyncReturn {
  /** True once at least one successful sync has completed. */
  isSynced: boolean;
  /** Set only when the most recent sync attempt failed; a stale offset is still used. */
  error: string | null;
  /** Best current estimate of the server's clock, given the last known offset. */
  getServerNow: () => number;
  /** Force an immediate re-sync (e.g. after a detected reconnect). */
  resync: () => Promise<void>;
}

/**
 * Keeps a clock offset against the signed server-time endpoint in sync,
 * so a countdown (useArenaTimer's `sync`) can be corrected against the
 * server's clock rather than the device's own, which may be skewed,
 * paused during sleep, or briefly wrong around a reconnect (#1401).
 */
export function useServerTimeSync(): UseServerTimeSyncReturn {
  const [isSynced, setIsSynced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offsetRef = useRef(0);
  const isVisible = usePageVisibility();
  const wasVisibleRef = useRef(isVisible);

  const resync = useCallback(async () => {
    try {
      const offset = await fetchServerTimeOffsetMs();
      offsetRef.current = offset;
      setIsSynced(true);
      setError(null);
    } catch (err) {
      // A failed refresh keeps the previous offset rather than clearing
      // it — a stale-but-recent estimate is more useful than none.
      setError(err instanceof Error ? err.message : "Server time sync failed.");
    }
  }, []);

  const getServerNow = useCallback(() => Date.now() + offsetRef.current, []);

  useEffect(() => {
    void resync();
  }, [resync]);

  useEffect(() => {
    if (!isVisible) return;

    const interval = setInterval(() => {
      void resync();
    }, REFRESH_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isVisible, resync]);

  // A visibility regain (tab foregrounded after being backgrounded, which
  // is also what happens on device wake from sleep) forces an immediate
  // resync rather than waiting for the next interval tick, since the
  // device's clock may have paused or drifted while backgrounded.
  useEffect(() => {
    if (isVisible && !wasVisibleRef.current) {
      void resync();
    }
    wasVisibleRef.current = isVisible;
  }, [isVisible, resync]);

  return { isSynced, error, getServerNow, resync };
}
