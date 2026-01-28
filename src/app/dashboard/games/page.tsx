"use client";

import { GamesHeader } from "@/features/games/components/GamesHeader";
import { GamesStats } from "@/features/games/components/GamesStats";
import { GamesFilters } from "@/features/games/components/GamesFilters";
import { ArenaCard } from "@/features/games/components/ArenaCard";
import { mockArenas } from "@/features/games/mockArenas";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";

export default function GamesPage() {
  const searchParams = useSearchParams();
  const filter = searchParams.get("filter") || "all";
  const search = searchParams.get("q") || "";

  const filteredArenas = useMemo(() => {
    let arenas = [...mockArenas];

    if (filter === "high-stakes") {
      arenas = arenas.filter(arena => arena.badge === "WHALE" || parseFloat(arena.stake) > 100);
    } else if (filter === "fast-rounds") {
      arenas = arenas.filter(arena => arena.badge === "BLITZ" || arena.roundSpeed.includes("30s"));
    }

    if (search) {
      const searchLower = search.toLowerCase();
      arenas = arenas.filter(arena =>
        arena.id.toLowerCase().includes(searchLower) ||
        arena.number.toLowerCase().includes(searchLower)
      );
    }

    return arenas;
  }, [filter, search]);

  return (
    <div className="flex flex-col min-h-full">
      <div className="flex justify-between items-start mb-4">
        <GamesHeader />
        <GamesStats />
      </div>

      <GamesFilters />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 grow">
        {filteredArenas.length > 0 ? (
          filteredArenas.map((arena) => (
            <ArenaCard key={arena.id} arena={arena} />
          ))
        ) : (
          <div className="col-span-full text-center py-12">
            <p className="text-zinc-500 text-sm uppercase tracking-wider">
              No arenas found matching your criteria
            </p>
          </div>
        )}
      </div>
    </div>
  );
}