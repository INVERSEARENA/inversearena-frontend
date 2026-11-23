"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiClient } from "@/shared/lib/api/client";

export type ReasonCode =
  | "similar_stake"
  | "friend_joined"
  | "preferred_asset"
  | "typical_size"
  | "popular_now";

export interface RecommendedArena {
  id: string;
  name: string;
  currency: string;
  currentPlayers: number;
  maxPlayers: number;
  currentPot: number;
  entryFee: number;
  reasons: ReasonCode[];
  score: number; // internal ranking score
}

const REASON_LABELS: Record<ReasonCode, string> = {
  similar_stake:    "Similar stake",
  friend_joined:    "Friend joined",
  preferred_asset:  "Preferred asset",
  typical_size:     "Your size",
  popular_now:      "Trending",
};



function useRecommendedArenas(address: string | undefined) {
  const [arenas, setArenas] = useState<RecommendedArena[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  useEffect(() => {
    if (!address) {
      // Cold-start: show nothing — the rail is hidden
      setStatus("idle");
      return;
    }
    let cancelled = false;
    const load = async () => {
      setStatus("loading");
      try {
        const data = await apiClient.get<RecommendedArena[]>(
          `/api/players/${address}/recommendations`,
          { params: { limit: "4" } },
        );
        if (!cancelled) { setArenas(data); setStatus("success"); }
      } catch {
        if (!cancelled) setStatus("error");
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [address]);

  return { arenas, status };
}

interface Props {
  playerAddress: string | undefined;
}

export function RecommendedArenas({ playerAddress }: Props) {
  const router = useRouter();
  const { arenas, status } = useRecommendedArenas(playerAddress);

  if (status === "idle" || (status === "success" && arenas.length === 0)) return null;

  return (
    <section className="font-mono" aria-label="Recommended arenas">
      <div className="mb-3 flex items-center gap-2">
        <SparklesIcon className="size-4 text-[#37FF1C]" />
        <h2 className="text-xs font-bold tracking-widest text-zinc-300">
          RECOMMENDED FOR YOU
        </h2>
      </div>

      {status === "loading" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse border border-[#1c2739] bg-[#0d1b2a]" />
          ))}
        </div>
      )}

      {status === "error" && (
        <p className="text-xs text-zinc-500">Could not load recommendations.</p>
      )}

      {status === "success" && arenas.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {arenas.map((arena) => (
            <RecommendedArenaCard
              key={arena.id}
              arena={arena}
              onJoin={() => router.push(`/arena/${arena.id}`)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RecommendedArenaCard({
  arena,
  onJoin,
}: {
  arena: RecommendedArena;
  onJoin: () => void;
}) {
  const fill = (arena.currentPlayers / arena.maxPlayers) * 100;

  return (
    <div className="flex flex-col justify-between border border-[#1c2739] bg-black/50 p-4">
      <div>
        <p className="truncate text-sm font-bold text-white">{arena.name}</p>
        <p className="mt-0.5 text-xs text-zinc-400">
          {arena.currentPot.toLocaleString()} {arena.currency}
        </p>

        <div className="mt-2 flex flex-wrap gap-1">
          {arena.reasons.slice(0, 2).map((r) => (
            <span
              key={r}
              className="inline-block rounded-sm bg-[#0d1b2a] px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-[#37FF1C]"
            >
              {REASON_LABELS[r]}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-3">
        <div className="mb-1 flex justify-between text-[10px] text-zinc-500">
          <span>PLAYERS</span>
          <span>
            <span className="text-[#37FF1C]">{arena.currentPlayers}</span>/{arena.maxPlayers}
          </span>
        </div>
        <div className="h-1 w-full bg-zinc-800">
          <div className="h-full bg-[#37FF1C]" style={{ width: `${fill}%` }} />
        </div>

        <button
          type="button"
          onClick={onJoin}
          className="mt-3 w-full bg-[#37FF1C] py-1.5 text-xs font-bold text-black transition-colors hover:bg-[#2be012]"
        >
          JOIN
        </button>
      </div>
    </div>
  );
}

function SparklesIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
    </svg>
  );
}
