import { GamesHeader } from "@/features/games/components/GamesHeader";
import { GamesStats } from "@/features/games/components/GamesStats";
import { GamesFilters } from "@/features/games/components/GamesFilters";
import { ArenaCard } from "@/features/games/components/ArenaCard";
import { mockArenas } from "@/features/games/mockArenas";

export default function GamesPage() {
  return (
    <div className="flex flex-col min-h-full">
      <div className="flex justify-between items-start mb-4">
        <GamesHeader />
        <GamesStats />
      </div>

      <GamesFilters />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-grow">
        {/* Top row: Featured + Medium */}
        <ArenaCard arena={mockArenas[0]} />
        <ArenaCard arena={mockArenas[1]} />

        {/* Bottom row: Small cards */}
        {mockArenas.slice(2).map((arena) => (
          <ArenaCard key={arena.id} arena={arena} />
        ))}
      </div>
    </div>
  );
}

