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

      {/* Terminal Footer Info */}
      <div className="mt-12 pt-8 border-t border-white/5 flex justify-between items-center text-white/40 font-mono text-[9px] uppercase tracking-[0.3em]">
        <div className="flex gap-12">
          <div>
            <span className="block mb-1 text-zinc-700 font-bold">TERMINAL_VERSION</span>
            <span>V2.4.0-SOROBAN</span>
          </div>
          <div>
            <span className="block mb-1 text-zinc-700 font-bold">LATENCY</span>
            <span>24MS</span>
          </div>
          <div>
            <span className="block mb-1 text-zinc-700 font-bold">ACTIVE_POOLS</span>
            <span>142</span>
          </div>
        </div>

        <div className="flex gap-4">
          <button className="p-3 border border-white/10 hover:bg-white/5">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M21 16.5c0 .38-.21.71-.53.88l-7.9 4.44c-.16.09-.36.14-.57.14s-.41-.05-.57-.14l-7.9-4.44c-.31-.17-.53-.5-.53-.88v-9c0-.38.21-.71.53-.88l7.9-4.44c.16-.09.36-.14.57-.14s.41.05.57.14l7.9 4.44c.31.17.53.5.53.88v9z" /></svg>
          </button>
          <button className="p-3 border border-white/10 hover:bg-white/5">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M11.5 2C6.81 2 3 5.81 3 10.5S6.81 19 11.5 19h.5v3c4.86-2.36 8-6.29 8-11.5C20 5.81 16.19 2 11.5 2zm1 14.5h-2v-2h2v2zm0-3.5h-2c0-3.25 2.5-3 2.5-5 0-1.1-.9-2-2-2s-2 .9-2 2h-2c0-2.21 1.79-4 4-4s4 1.79 4 4c0 2.5-2.5 2.5-2.5 5z" /></svg>
          </button>
          <button className="px-6 py-3 bg-white text-black font-bold text-[10px] tracking-widest hover:bg-zinc-200 transition-colors">
            RELOAD_SYSTEM
          </button>
        </div>
      </div>
    </div>
  );
}

