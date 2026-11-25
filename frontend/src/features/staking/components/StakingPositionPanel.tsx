/**
 * Staking position panel (#1510).
 *
 * Renders the chain-backed staking position with explicit loading, empty,
 * active, unavailable, and error states. An unreadable chain is shown as
 * "unavailable" — never as a zero balance — so the user is never told they
 * have nothing staked when the truth is that we could not read the chain.
 */

"use client";

import React from "react";

import { formatMinorUnits } from "../model/formatAmount";
import { useStakingPosition, type StakingPosition } from "../hooks/useStakingPosition";

interface StakingPositionPanelProps {
  onUnstake?: (position: StakingPosition) => void;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs uppercase tracking-wide text-gray-400">{label}</span>
      <span className="text-lg font-mono text-neon-green">{value}</span>
    </div>
  );
}

export default function StakingPositionPanel({ onUnstake }: StakingPositionPanelProps) {
  const { position, state, loading, error, refresh } = useStakingPosition();

  if (loading) {
    return (
      <section
        data-testid="staking-position-panel"
        data-state="loading"
        className="rounded-lg border border-white/10 bg-black/40 p-6"
      >
        <h2 className="text-lg font-semibold text-white">Staking position</h2>
        <p className="mt-2 text-sm text-gray-400">Loading your staking position…</p>
      </section>
    );
  }

  if (state === "error") {
    return (
      <section
        data-testid="staking-position-panel"
        data-state="error"
        className="rounded-lg border border-red-500/40 bg-black/40 p-6"
      >
        <h2 className="text-lg font-semibold text-white">Staking position</h2>
        <p className="mt-2 text-sm text-red-400">{error ?? "Failed to load staking position"}</p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="mt-3 rounded border border-white/20 px-3 py-1 text-sm text-white hover:bg-white/10"
        >
          Retry
        </button>
      </section>
    );
  }

  if (state === "unavailable") {
    return (
      <section
        data-testid="staking-position-panel"
        data-state="unavailable"
        className="rounded-lg border border-amber-500/40 bg-black/40 p-6"
      >
        <h2 className="text-lg font-semibold text-white">Staking position</h2>
        <p className="mt-2 text-sm text-amber-400">
          The staking contract could not be read. Balances are hidden rather than shown as zero.
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="mt-3 rounded border border-white/20 px-3 py-1 text-sm text-white hover:bg-white/10"
        >
          Retry
        </button>
      </section>
    );
  }

  if (state === "empty" || !position) {
    return (
      <section
        data-testid="staking-position-panel"
        data-state="empty"
        className="rounded-lg border border-white/10 bg-black/40 p-6"
      >
        <h2 className="text-lg font-semibold text-white">Staking position</h2>
        <p className="mt-2 text-sm text-gray-400">You have no active staking position.</p>
      </section>
    );
  }

  const decimals = position.assetDecimals;

  return (
    <section
      data-testid="staking-position-panel"
      data-state="active"
      className="rounded-lg border border-neon-green/30 bg-black/40 p-6"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Staking position</h2>
        {position.freshness === "stale" && (
          <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300">stale</span>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Principal" value={formatMinorUnits(position.principalEquivalent, decimals)} />
        <Stat label="Shares" value={formatMinorUnits(position.shares, decimals)} />
        <Stat label="Rewards" value={formatMinorUnits(position.accruedRewards, decimals)} />
        <Stat label="Withdrawable" value={formatMinorUnits(position.withdrawable, decimals)} />
      </div>

      <p className="mt-3 text-xs text-gray-500">
        {position.ledger !== null ? `Ledger ${position.ledger} · ` : ""}
        observed {position.observedAt}
        {position.contractVersion !== null ? ` · v${position.contractVersion}` : ""}
      </p>

      {onUnstake && (
        <button
          type="button"
          onClick={() => onUnstake(position)}
          className="mt-4 rounded border border-neon-green/40 px-4 py-2 text-sm text-neon-green hover:bg-neon-green/10"
        >
          Unstake
        </button>
      )}
    </section>
  );
}
