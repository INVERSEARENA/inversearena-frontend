"use client";

import { GamesHeader } from "@/features/games/components/GamesHeader";
import { GamesStats } from "@/features/games/components/GamesStats";
import { GamesFilters } from "@/features/games/components/GamesFilters";
import { ArenaCard } from "@/features/games/components/ArenaCard";
import { ArenaCardSkeleton } from "@/features/games/components/ArenaCardSkeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { mockArenas } from "@/features/games/mockArenas";
import { useSearchParams } from "next/navigation";
import { useMemo, useState, useEffect } from "react";
import { Search } from "lucide-react";

export default function GamesPage() {
  const searchParams = useSearchParams();
  const filter = searchParams.get("filter") || "all";
  const search = searchParams.get("q") || "";
  const [isLoading, setIsLoading] = useState(true);

  // Simulate loading
  useEffect(() => {
    const timer = setTimeout(() => setIsLoading(false), 800);
    return () => clearTimeout(timer);
  }, []);

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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 grow mt-4">
        {isLoading ? (
          <>
            <ArenaCardSkeleton isFeatured={true} />
            <ArenaCardSkeleton />
            <ArenaCardSkeleton />
            <ArenaCardSkeleton />
          </>
        ) : filteredArenas.length > 0 ? (
          filteredArenas.map((arena) => (
            <ArenaCard key={arena.id} arena={arena} />
          ))
        ) : (
          <div className="col-span-full py-12">
            <EmptyState
              icon={Search}
              title="No Arenas Found"
              description={`No results matching your current filters: "${search || filter}". Try adjusting your search or filters.`}
              actionLabel="Clear Filters"
              onAction={() => window.location.href = "/dashboard/games"}
            />
          </div>
        )}
      </div>
    </div>
  );
}