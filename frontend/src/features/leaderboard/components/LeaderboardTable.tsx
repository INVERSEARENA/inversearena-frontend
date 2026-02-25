"use client";

import { Survivor } from "../types";
import { RankTableRow } from "./RankTableRow";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Users } from "lucide-react";

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
      <div className={`bg-card-bg border border-white/10 overflow-hidden ${className}`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px]">
            <thead>
              <tr className="border-b border-white/10 bg-dark-bg/50 text-left">
                <th className="py-4 pl-6 pr-4 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-white/50">Rank</th>
                <th className="px-4 py-4 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-white/50">Agent ID</th>
                <th className="px-4 py-4 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-white/50">Survival Streak</th>
                <th className="px-4 py-4 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-white/50">Total Yield</th>
                <th className="px-4 py-4 text-center font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-white/50">Arenas Won</th>
                <th className="py-4 pl-4 pr-6 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-white/50">Action</th>
              </tr>
            </thead>
            <tbody>
              {[...Array(5)].map((_, i) => (
                <tr key={i} className="border-b border-white/5">
                  <td className="py-5 pl-6 pr-4"><Skeleton className="h-8 w-8" /></td>
                  <td className="px-4 py-5"><Skeleton className="h-4 w-32" /></td>
                  <td className="px-4 py-5"><Skeleton className="h-8 w-24" /></td>
                  <td className="px-4 py-5"><Skeleton className="h-5 w-20" /></td>
                  <td className="px-4 py-5 flex justify-center"><Skeleton className="h-5 w-12" /></td>
                  <td className="py-5 pl-4 pr-6"><Skeleton className="h-10 w-28" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (survivors.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No Survivors Found"
        description="The arena is currently empty. Be the first to join and dominate the leaderboard!"
        actionLabel="Join Your First Arena"
        onAction={() => window.location.href = "/dashboard/games"}
        className={className}
      />
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

