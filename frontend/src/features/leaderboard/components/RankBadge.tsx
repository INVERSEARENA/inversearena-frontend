"use client";

import type { RankMovement } from "../types";

interface RankBadgeProps {
  rank: number;
  /**
   * Optional rank change since the previous snapshot. When provided, an
   * animated arrow is shown (#662). Omit when no prior rank is known.
   */
  movement?: RankMovement;
}

/** Medal styling for the top three ranks; plain styling below. */
const MEDAL: Record<number, string> = {
  1: "text-[#FFD700] drop-shadow-[0_0_6px_rgba(255,215,0,0.5)]",
  2: "text-[#C0C0C0] drop-shadow-[0_0_6px_rgba(192,192,192,0.45)]",
  3: "text-[#CD7F32] drop-shadow-[0_0_6px_rgba(205,127,50,0.45)]",
};

const MOVEMENT_META: Record<RankMovement, { symbol: string; className: string; label: string }> = {
  up: { symbol: "▲", className: "text-neon-green", label: "moved up" },
  down: { symbol: "▼", className: "text-neon-pink", label: "moved down" },
  same: { symbol: "–", className: "text-white/40", label: "unchanged" },
};

/**
 * Displays a leaderboard rank with medal styling for the top three and an
 * optional animated indicator for rank changes (#662).
 */
export function RankBadge({ rank, movement }: RankBadgeProps) {
  const medalClass = MEDAL[rank] ?? "text-white";
  const move = movement ? MOVEMENT_META[movement] : null;

  return (
    <span className="inline-flex items-center gap-1.5" data-testid="rank-badge">
      <span
        className={`font-display text-3xl font-light italic transition-all duration-300 ${medalClass}`}
      >
        {rank}
      </span>
      {move ? (
        <span
          role="img"
          aria-label={`Rank ${move.label}`}
          className={`text-xs font-bold animate-in fade-in zoom-in duration-300 ${move.className}`}
        >
          {move.symbol}
        </span>
      ) : null}
    </span>
  );
}
