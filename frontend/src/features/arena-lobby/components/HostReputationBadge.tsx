"use client";

import { useState } from "react";
import type { HostReputation, ReputationTier } from "./host-reputation-types";
import { computeReputationTier } from "./host-reputation-types";

const TIER_STYLES: Record<ReputationTier, { label: string; color: string; ring: string }> = {
  elite:    { label: "ELITE HOST",    color: "text-[#37FF1C]", ring: "ring-[#37FF1C]/40" },
  trusted:  { label: "TRUSTED HOST",  color: "text-sky-400",   ring: "ring-sky-400/40"   },
  new:      { label: "NEW HOST",       color: "text-zinc-400",  ring: "ring-zinc-400/40"  },
  cautious: { label: "CAUTIOUS",       color: "text-amber-400", ring: "ring-amber-400/40" },
  unknown:  { label: "NO SCORE YET",  color: "text-zinc-500",  ring: "ring-zinc-700/40"  },
};

interface Props {
  reputation: HostReputation;
  compact?: boolean;
}

export function HostReputationBadge({ reputation, compact = false }: Props) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const tier = computeReputationTier(reputation.score);
  const style = TIER_STYLES[tier];

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => setShowBreakdown((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-xs font-bold tracking-wider ring-1 ${style.color} ${style.ring} bg-black/60`}
        aria-label={`Host reputation: ${style.label}${reputation.score !== null ? `, score ${reputation.score}` : ""}`}
      >
        <ShieldIcon className="size-3" />
        {reputation.score !== null ? reputation.score : "—"}
      </button>
    );
  }

  return (
    <div className="font-mono">
      <button
        type="button"
        onClick={() => setShowBreakdown((v) => !v)}
        className={`flex items-center gap-2 text-sm font-bold tracking-wider ${style.color}`}
        aria-expanded={showBreakdown}
      >
        <ShieldIcon className="size-4" />
        <span>{style.label}</span>
        {reputation.score !== null && (
          <span className="text-white">{reputation.score}/100</span>
        )}
        <ChevronIcon open={showBreakdown} />
      </button>

      {showBreakdown && (
        <div className="mt-3 space-y-2 border border-[#1c2739] bg-black/60 p-4 text-xs">
          {reputation.score === null ? (
            <p className="text-zinc-400">
              Score available after {5} hosted arenas. Currently:{" "}
              {reputation.breakdown.arenasHosted} hosted.
            </p>
          ) : (
            <>
              <BreakdownRow
                label="Completion rate"
                value={`${Math.round(reputation.breakdown.completionRate * 100)}%`}
                weight="40%"
              />
              <BreakdownRow
                label="Avg start delay"
                value={formatDelay(reputation.breakdown.avgStartDelaySeconds)}
                weight="25%"
              />
              <BreakdownRow
                label="Disputes"
                value={String(reputation.breakdown.disputeCount)}
                weight="20%"
              />
              <BreakdownRow
                label="Keeper takeovers"
                value={String(reputation.breakdown.keeperTakeovers)}
                weight="15%"
              />
              <p className="mt-2 text-zinc-500">
                Formula v{reputation.formulaVersion} · {reputation.breakdown.arenasHosted} arenas ·
                updated {new Date(reputation.computedAt).toLocaleDateString()}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function BreakdownRow({ label, value, weight }: { label: string; value: string; weight: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-zinc-400">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-white">{value}</span>
        <span className="text-zinc-600">({weight})</span>
      </div>
    </div>
  );
}

function formatDelay(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`size-3 transition-transform ${open ? "rotate-180" : ""}`}
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
    </svg>
  );
}
