/**
 * Chain-backed staking position hook (#1510).
 *
 * Fetches the authenticated wallet's staking position from the backend and
 * exposes it with an explicit freshness state. The panel never renders an
 * unreadable chain as a zero balance: `unavailable` is a distinct state from
 * "no position".
 *
 * Amounts arrive as exact integer minor-unit strings and are rendered with the
 * asset decimals returned by the API — no floating-point scaling happens here.
 *
 * @module
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiClient } from "@/shared/lib/api/client";

export type StakingFreshness = "verified" | "stale" | "unavailable";

export interface StakingPosition {
  wallet: string;
  assetDecimals: number;
  network: string;
  contractVersion: number | null;
  freshness: StakingFreshness;
  ledger: number | null;
  observedAt: string;
  shares: string | null;
  principalEquivalent: string | null;
  accruedRewards: string | null;
  withdrawable: string | null;
  minInitialStake: string | null;
  totalStaked: string | null;
  totalShares: string | null;
}

export type StakingPositionState =
  | "loading"
  | "empty"
  | "active"
  | "unavailable"
  | "error";

export interface UseStakingPositionReturn {
  position: StakingPosition | null;
  state: StakingPositionState;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

function isNonZero(value: string | null): boolean {
  return value !== null && /[1-9]/.test(value);
}

/**
 * Derive the display state from a position. `unavailable` (the chain could not
 * be read) is deliberately distinct from `empty` (the chain was read and the
 * wallet simply has no position).
 */
export function deriveStakingState(position: StakingPosition | null): StakingPositionState {
  if (!position) return "loading";
  if (position.freshness === "unavailable") return "unavailable";
  if (!isNonZero(position.shares) && !isNonZero(position.withdrawable)) return "empty";
  return "active";
}

async function fetchPosition(): Promise<StakingPosition> {
  const body = await apiClient.get<{ position?: StakingPosition }>(
    "/api/users/me/staking/positions",
    { cache: "no-store" },
  );
  if (!body || typeof body !== "object" || !body.position) {
    throw new Error("Invalid staking position response");
  }
  return body.position;
}

export function useStakingPosition(): UseStakingPositionReturn {
  const [position, setPosition] = useState<StakingPosition | null>(null);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setErrored(false);
    try {
      setPosition(await fetchPosition());
    } catch (err) {
      setErrored(true);
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const state = useMemo<StakingPositionState>(
    () => (errored ? "error" : deriveStakingState(position)),
    [errored, position],
  );

  return { position, state, loading, error, refresh };
}
