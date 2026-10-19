"use client";

import { GamesHeader } from "@/features/games/components/GamesHeader";
import { GamesStats } from "@/features/games/components/GamesStats";
import { GamesFilters } from "@/features/games/components/GamesFilters";
import { ArenaCard } from "@/features/games/components/ArenaCard";
import { ArenaCardSkeleton } from "@/features/games/components/ArenaCardSkeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, useEffect } from "react";
import { Search } from "lucide-react";
import type { Arena } from "@/features/games/model/types";

function GamesPageContent() {
  const searchParams = useSearchParams();
  const filter = searchParams.get("filter") || "all";
  const search = searchParams.get("q") || "";
  const [isLoading, setIsLoading] = useState(true);
  const [arenas, setArenas] = useState<Arena[]>([]);

  useEffect(() => {
    async function fetchArenas() {
      try {
        setIsLoading(true);
        const params = new URLSearchParams();
        if (search) params.append("q", search);
        if (filter && filter !== "all") params.append("filter", filter);
        params.append("limit", "100");

        const response = await fetch(`/api/arenas?${params.toString()}`);
        if (!response.ok) throw new Error("Failed to fetch arenas");

        const data = await response.json();
        setArenas(data.items || []);
      } catch (error) {
        console.error("Error fetching arenas:", error);
        setArenas([]);
      } finally {
        setIsLoading(false);
      }
    }

    fetchArenas();
  }, [filter, search]);

  return (
    <div className="flex flex-col min-h-full">
      <div className="sticky top-0 z-20 -mx-6 -mt-6 border-b border-white/5 bg-dark-bg/95 px-6 pt-6 pb-4 backdrop-blur">
        <div className="flex justify-between items-start mb-4">
          <GamesHeader />
          <GamesStats />
        </div>

        <GamesFilters />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 grow mt-4">
        {isLoading ? (
          <>
            <ArenaCardSkeleton isFeatured={true} />
            <ArenaCardSkeleton />
            <ArenaCardSkeleton />
            <ArenaCardSkeleton />
          </>
        ) : arenas.length > 0 ? (
          arenas.map((arena) => (
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

export default function GamesPage() {
  return (
    <Suspense>
      <GamesPageContent />
    </Suspense>
  );
}
