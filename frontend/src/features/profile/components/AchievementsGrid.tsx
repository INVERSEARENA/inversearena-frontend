"use client";

import { useEffect, useState } from "react";
import {
  ACHIEVEMENTS,
  getAchievementById,
  sortByTier,
  type AchievementTier,
  type PlayerAchievement,
} from "./achievement-types";

const TIER_COLORS: Record<AchievementTier, { border: string; label: string; bg: string }> = {
  bronze:   { border: "border-amber-700",   label: "text-amber-500",  bg: "bg-amber-900/20"  },
  silver:   { border: "border-zinc-400",    label: "text-zinc-300",   bg: "bg-zinc-800/30"   },
  gold:     { border: "border-yellow-500",  label: "text-yellow-400", bg: "bg-yellow-900/20" },
  platinum: { border: "border-sky-400",     label: "text-sky-300",    bg: "bg-sky-900/20"    },
};

interface Props {
  unlockedAchievements: PlayerAchievement[];
  loading?: boolean;
}

export function AchievementsGrid({ unlockedAchievements, loading = false }: Props) {
  const unlockedIds = new Set(unlockedAchievements.map((a) => a.definitionId));
  const sorted = sortByTier(ACHIEVEMENTS);

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse border border-[#1c2739] bg-[#0d1b2a]" />
        ))}
      </div>
    );
  }

  return (
    <div className="font-mono">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-bold tracking-widest text-zinc-300">ACHIEVEMENTS</h3>
        <span className="text-xs text-zinc-500">
          {unlockedIds.size} / {ACHIEVEMENTS.length} unlocked
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {sorted.map((def) => {
          const unlocked = unlockedIds.has(def.id);
          const playerRecord = unlockedAchievements.find((a) => a.definitionId === def.id);
          const style = TIER_COLORS[def.tier];

          return (
            <div
              key={def.id}
              className={`relative flex flex-col gap-2 border p-3 transition-opacity ${
                unlocked ? `${style.border} ${style.bg}` : "border-[#1c2739] opacity-40"
              }`}
              title={def.criteria}
            >
              <div className="flex items-start justify-between">
                <TrophyIcon
                  className={`size-5 ${unlocked ? style.label : "text-zinc-600"}`}
                />
                <span
                  className={`text-[10px] font-bold tracking-widest uppercase ${
                    unlocked ? style.label : "text-zinc-600"
                  }`}
                >
                  {def.tier}
                </span>
              </div>

              <div>
                <p className={`text-xs font-bold ${unlocked ? "text-white" : "text-zinc-500"}`}>
                  {def.title}
                </p>
                <p className="mt-0.5 text-[10px] leading-tight text-zinc-500">
                  {def.description}
                </p>
              </div>

              {unlocked && playerRecord && (
                <p className="text-[9px] text-zinc-600">
                  {new Date(playerRecord.unlockedAt).toLocaleDateString()}
                </p>
              )}

              {!unlocked && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <LockIcon className="size-4 text-zinc-700" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AchievementUnlockToast({
  achievementId,
  onDismiss,
}: {
  achievementId: string;
  onDismiss: () => void;
}) {
  const def = getAchievementById(achievementId);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setVisible(false);
      setTimeout(onDismiss, 300);
    }, 4000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  if (!def) return null;
  const style = TIER_COLORS[def.tier];

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-6 right-6 z-50 flex max-w-xs items-start gap-3 border p-4 font-mono shadow-xl transition-opacity duration-300 ${
        visible ? "opacity-100" : "opacity-0"
      } ${style.border} ${style.bg} bg-black`}
    >
      <TrophyIcon className={`mt-0.5 size-5 shrink-0 ${style.label}`} />
      <div>
        <p className={`text-xs font-bold tracking-wider ${style.label}`}>
          ACHIEVEMENT UNLOCKED
        </p>
        <p className="mt-0.5 text-sm font-bold text-white">{def.title}</p>
        <p className="text-xs text-zinc-400">{def.description}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="ml-auto shrink-0 text-zinc-500 hover:text-white"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

function TrophyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 18.75h-9m9 0a3 3 0 0 1 3 3h-15a3 3 0 0 1 3-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 0 1-.982-3.172M9.497 14.25a7.454 7.454 0 0 0 .981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 0 0 7.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 0 0 2.748 1.35m8.272-6.842V4.5c0 2.108-.966 3.99-2.48 5.228m2.48-5.492a46.32 46.32 0 0 1 2.916.52 6.003 6.003 0 0 1-5.395 4.972m0 0a6.726 6.726 0 0 1-2.749 1.35m0 0a6.772 6.772 0 0 1-3.044 0" />
    </svg>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
    </svg>
  );
}
