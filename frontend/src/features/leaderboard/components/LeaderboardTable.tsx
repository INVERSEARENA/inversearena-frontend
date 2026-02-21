"use client";

import { Survivor } from "../types";
import { RankTableRow } from "./RankTableRow";

interface LeaderboardTableProps {
  survivors: Survivor[];
  onChallenge?: (survivorId: string) => void;
  isLoading?: boolean;
  className?: string;
}

// Rankings table for survivors (4th place onwards)
export function LeaderboardTable({
  survivors,
  onChallenge,
  isLoading = false,
  className = "",
}: LeaderboardTableProps) {
  if (isLoading) {
    return (
      <div className={`bg-card-bg border border-white/10 ${className}`}>
        <div className="flex h-64 items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-neon-green border-t-transparent" />
            <span className="font-mono text-xs uppercase tracking-widest text-white/60">
              Loading Rankings...
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (survivors.length === 0) {
    return (
      <div className={`bg-card-bg border border-white/10 ${className}`}>
        <div className="flex h-64 items-center justify-center">
          <span className="font-mono text-sm text-white/40">
            No survivors found
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={`bg-card-bg border border-white/10 overflow-hidden ${className}`}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px]" role="table">
          <thead>
            <tr className="border-b border-white/10 bg-dark-bg/50">
              <th
                scope="col"
                className="py-4 pl-6 pr-4 text-left font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-white/50"
              >
                Rank
              </th>
              <th
                scope="col"
                className="px-4 py-4 text-left font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-white/50"
              >
                Agent ID
              </th>
              <th
                scope="col"
                className="px-4 py-4 text-left font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-white/50"
              >
                Survival Streak
              </th>
              <th
                scope="col"
                className="px-4 py-4 text-left font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-white/50"
              >
                Total Yield
              </th>
              <th
                scope="col"
                className="px-4 py-4 text-center font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-white/50"
              >
                Arenas Won
              </th>
              <th
                scope="col"
                className="py-4 pl-4 pr-6 text-left font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-white/50"
              >
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {survivors.map((survivor) => (
              <RankTableRow
                key={survivor.id}
                survivor={survivor}
                onChallenge={onChallenge}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
