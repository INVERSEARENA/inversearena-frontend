/**
 * Claim inbox data hook (#1489).
 *
 * Owns the wallet-scoped inbox: cursor pagination, refresh, and the
 * reconciliation step that follows a claim or refund submission.
 *
 * The reconciliation rule is the important part. When the user signs a claim we
 * do **not** flip the item to `completed` locally — the local copy of a
 * transaction is not evidence that it settled, and a panel that shows money as
 * received before the chain agrees is worse than one that shows it as pending.
 * Instead the arena is marked as awaiting reconciliation, the page is refetched,
 * and whatever the server then says is what renders.
 *
 * @module
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { claimInboxPageSchema, type ClaimInboxItem, type ClaimInboxSummary } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
const PAGE_SIZE = 20;

export interface UseClaimInboxReturn {
  items: ClaimInboxItem[];
  summary: ClaimInboxSummary | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  /**
   * `false` when at least one on-chain read failed or was skipped. The panel
   * discloses this rather than implying every row is current.
   */
  verificationComplete: boolean;
  /** Arenas with a submitted action still waiting for the server to catch up. */
  reconciling: ReadonlySet<string>;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  /** Call after a claim or refund is submitted, with the arena it targeted. */
  markSubmitted: (arenaId: string) => Promise<void>;
}

function authHeaders(): HeadersInit {
  const token =
    typeof window !== "undefined" ? window.localStorage.getItem("access_token") : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchPage(cursor: string | null): Promise<ReturnType<typeof claimInboxPageSchema.parse>> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`${API_BASE}/api/users/me/claim-inbox?${params.toString()}`, {
    headers: authHeaders(),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Claim inbox request failed (${response.status})`);
  }
  const parsed = claimInboxPageSchema.safeParse(await response.json());
  if (!parsed.success) {
    // A mismatch is a bug in one of the two halves, not something to render
    // through. Say so instead of coercing fields into undefined balances.
    throw new Error(`Invalid claim inbox response: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Merge pages by arena id.
 *
 * One item per arena is the server's contract, so identity is the arena id and
 * a re-read of the same arena replaces the earlier copy rather than appending a
 * second row. Without this, refreshing after a submission would show the same
 * position twice and invite a second signature.
 */
function mergeByArena(existing: ClaimInboxItem[], incoming: ClaimInboxItem[]): ClaimInboxItem[] {
  const byArena = new Map(existing.map((item) => [item.arenaId, item]));
  for (const item of incoming) byArena.set(item.arenaId, item);
  return Array.from(byArena.values());
}

export function useClaimInbox(): UseClaimInboxReturn {
  const [items, setItems] = useState<ClaimInboxItem[]>([]);
  const [summary, setSummary] = useState<ClaimInboxSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [verificationComplete, setVerificationComplete] = useState(true);
  const [reconciling, setReconciling] = useState<ReadonlySet<string>>(new Set());
  // Guards against a slow first page landing after a refresh and overwriting
  // newer data.
  const requestSeq = useRef(0);

  const load = useCallback(async (nextCursor: string | null, replace: boolean) => {
    const seq = ++requestSeq.current;
    if (nextCursor) setLoadingMore(true);
    else setLoading(true);
    try {
      const page = await fetchPage(nextCursor);
      if (seq !== requestSeq.current) return;
      setItems((current) => (replace ? page.items : mergeByArena(current, page.items)));
      setSummary(page.summary);
      setCursor(page.cursor);
      setHasMore(page.hasMore);
      setVerificationComplete(page.verificationComplete);
      setError(null);
    } catch (caught) {
      if (seq !== requestSeq.current) return;
      setError(caught instanceof Error ? caught.message : "Failed to load claim inbox");
      if (replace) {
        // A failed first page leaves nothing trustworthy on screen. Clearing
        // avoids rendering yesterday's actionable state as if it were current.
        setItems([]);
        setSummary(null);
      }
      setHasMore(false);
      setCursor(null);
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    void load(null, true);
  }, [load]);

  const refresh = useCallback(async () => {
    await load(null, true);
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!cursor || loading || loadingMore) return;
    await load(cursor, false);
  }, [cursor, loading, loadingMore, load]);

  const markSubmitted = useCallback(
    async (arenaId: string) => {
      setReconciling((current) => new Set(current).add(arenaId));
      // Re-read rather than patch locally. The server owns the state machine,
      // and a local "completed" would be a settlement claim we cannot support.
      await load(null, true);
    },
    [load],
  );

  return useMemo(
    () => ({
      items,
      summary,
      loading,
      loadingMore,
      error,
      hasMore,
      verificationComplete,
      reconciling,
      refresh,
      loadMore,
      markSubmitted,
    }),
    [items, summary, loading, loadingMore, error, hasMore, verificationComplete, reconciling, refresh, loadMore, markSubmitted],
  );
}
