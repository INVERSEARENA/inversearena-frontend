"use client";

import { memo } from "react";
import {
  selectArenaHealth,
  selectArenaState,
  useArenaStore,
} from "@/features/arena/arenaStore";

export interface ArenaStateSummaryProps {
  className?: string;
}

function ArenaStateSummaryView({ className }: ArenaStateSummaryProps) {
  const state = useArenaStore(selectArenaState);
  const health = useArenaStore(selectArenaHealth);

  return (
    <section
      data-testid="arena-state-summary"
      className={className ?? "border border-white/10 bg-black/30 p-4"}
    >
      <p className="font-pixel text-[8px] tracking-widest text-white/60 uppercase">
        ARENA STATE
      </p>
      <p className="mt-2 font-mono text-sm text-white">
        {state ? `${state.status.toUpperCase()} / ROUND ${state.currentRound}` : "WAITING FOR ARENA"}
      </p>
      <p className="mt-1 font-mono text-xs text-white/60">
        {state ? `${state.survivorsCount}/${state.maxCapacity}` : "—"} · {health.toUpperCase()}
      </p>
    </section>
  );
}

export const ArenaStateSummary = memo(ArenaStateSummaryView);
