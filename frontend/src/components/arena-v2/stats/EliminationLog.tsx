"use client";

export interface EliminationEntry {
  id: string;
  label: string;
  status: "terminated" | "active";
}

interface EliminationLogProps {
  entries: EliminationEntry[];
}

export function EliminationLog({ entries }: EliminationLogProps) {
  return (
    <div className="bg-black border border-white/20 p-5 min-h-[130px] flex flex-col">
      <div className="flex items-center gap-2 mb-3 border-b border-white/10 pb-2">
        <svg viewBox="0 0 16 16" className="w-3 h-3 text-neon-green fill-current">
          <circle cx="8" cy="8" r="7" />
        </svg>
        <p className="text-[10px] font-bold tracking-[0.2em] uppercase text-white/70">
          Elimination Log
        </p>
      </div>
      <div className="space-y-2 flex-1">
        {entries.map((entry) => (
          <div key={entry.id} className="flex items-center justify-between">
            <span
              className={`font-pixel text-[11px] tracking-wider ${
                entry.status === "terminated"
                  ? "text-neon-pink/80"
                  : "text-white"
              }`}
            >
              {entry.label}
            </span>
            {entry.status === "terminated" ? (
              <span className="text-[9px] tracking-[0.15em] uppercase text-neon-pink/80 font-bold">
                Terminated
              </span>
            ) : (
              <span className="bg-neon-green text-black text-[9px] tracking-[0.15em] uppercase font-bold px-2 py-0.5">
                Active
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
