"use client";

import { useState } from "react";

const filters = [
  { id: "all-games", label: "ALL GAMES" },
  { id: "victories", label: "VICTORIES" },
  { id: "eliminations", label: "ELIMINATIONS" },
  { id: "hosted", label: "HOSTED" },
] as const;

export function ArchivesFilterBar() {
  const [activeFilter, setActiveFilter] = useState<(typeof filters)[number]["id"]>("all-games");

  return (
    <div className="mt-3 flex flex-wrap gap-2 md:gap-3">
      {filters.map((filter) => (
        <button
          key={filter.id}
          type="button"
          onClick={() => setActiveFilter(filter.id)}
          className={
            activeFilter === filter.id
              ? "border border-[#37FF1C] bg-[#37FF1C] px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-black transition-colors"
              : "border border-[#2B3A52] bg-[#121C2C] px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#9CA7BB] transition-colors hover:border-[#4B5B76]"
          }
        >
          {filter.label}
        </button>
      ))}
    </div>
  );
}
