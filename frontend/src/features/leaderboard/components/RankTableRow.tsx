"use client";

import { Survivor } from "../model/types";
import { formatAgentId, formatCurrency } from "../model/format";
import { RankBadge } from "./RankBadge";

interface RankTableRowProps {
  survivor: Survivor;
  onChallenge?: (survivorId: string) => void;
  /** Highlight the connected wallet's own row (#1567). */
  isHighlighted?: boolean;
}

// Single row in the leaderboard table
export function RankTableRow({ survivor, onChallenge, isHighlighted = false }: RankTableRowProps) {
  const handleChallenge = () => {
    onChallenge?.(survivor.id);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleChallenge();
    }
  };

  return (
    <tr
      className={`border-b border-white/5 transition-colors hover:bg-white/[0.02]${isHighlighted ? " bg-[#37FF1C]/10" : ""}`}
      {...(isHighlighted ? { "aria-current": "true" } : {})}
    >
      <td className="py-5 pl-6 pr-4">
        <RankBadge rank={survivor.rank} movement={survivor.rankMovement!} />
      </td>

      <td className="px-4 py-5">
        <span className="font-mono text-sm tracking-wider text-neon-pink">
          {formatAgentId(survivor.agentId)}
        </span>
      </td>

      <td className="px-4 py-5">
        <span className="inline-block rounded-sm border border-white/30 px-3 py-1.5 font-display text-xs font-medium italic tracking-wide text-white">
          {survivor.survivalStreak} ROUNDS
        </span>
      </td>

      <td className="px-4 py-5">
        <span className="font-mono text-base font-semibold tracking-wide text-neon-green">
          {formatCurrency(survivor.totalYield)}
        </span>
      </td>

      <td className="px-4 py-5 text-center">
        <span className="font-mono text-base text-white">
          {survivor.arenasWon}
        </span>
      </td>

      <td className="py-5 pl-4 pr-6">
        <button
          onClick={handleChallenge}
          onKeyDown={handleKeyDown}
          className="bg-neon-pink px-6 py-2.5 font-display text-xs font-bold uppercase tracking-widest text-white transition-all hover:bg-neon-pink/80 hover:scale-105 focus:outline-none focus:ring-2 focus:ring-neon-pink focus:ring-offset-2 focus:ring-offset-dark-bg active:scale-95"
          aria-label={`Challenge ${formatAgentId(survivor.agentId)}`}
        >
          CHALLENGE
        </button>
      </td>
    </tr>
  );
}
