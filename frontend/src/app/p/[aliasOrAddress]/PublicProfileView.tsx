"use client";

import { useState } from "react";
import Link from "next/link";
import { Share2, Check, Shield, Trophy, Swords, Zap, ExternalLink } from "lucide-react";

export interface PublicProfileData {
  address: string;
  alias: string | null;
  level: number;
  joinedAt: string;
  stats: {
    gamesPlayed: number;
    gamesWon: number;
    totalYieldEarned: string;
    currentRank: number | null;
    winRate: number;
  };
  achievements: Array<{
    definitionId: string;
    title: string;
    description: string;
    tier: "bronze" | "silver" | "gold" | "platinum";
    unlockedAt: string;
  }>;
  recentSettledArenas: Array<{
    arenaId: string;
    name: string;
    settledAt: string;
    result: "won" | "eliminated" | "participant";
    payout?: string;
  }>;
  privacy: {
    hideHistory: boolean;
    hideFromSearch: boolean;
  };
  isUnknown?: boolean;
  isBanned?: boolean;
}

const TIER_STYLES: Record<string, { border: string; text: string; bg: string }> = {
  bronze: { border: "border-amber-700/60", text: "text-amber-500", bg: "bg-amber-950/20" },
  silver: { border: "border-zinc-400/60", text: "text-zinc-300", bg: "bg-zinc-800/20" },
  gold: { border: "border-yellow-500/60", text: "text-yellow-400", bg: "bg-yellow-950/20" },
  platinum: { border: "border-sky-400/60", text: "text-sky-300", bg: "bg-sky-950/20" },
};

function formatShortAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-6)}`;
}

export function PublicProfileView({ profile }: { profile: PublicPlayerProfileData }) {
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    if (typeof window === "undefined") return;
    try {
      if (navigator.share) {
        await navigator.share({
          title: `${profile.alias || formatShortAddress(profile.address)} - Inverse Arena Profile`,
          url: window.location.href,
        });
      } else {
        await navigator.clipboard.writeText(window.location.href);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (profile.isBanned) {
    return (
      <div className="mx-auto max-w-4xl p-6 font-mono text-white">
        <div className="border border-red-500/50 bg-red-950/20 p-8 text-center rounded-lg">
          <Shield className="mx-auto size-12 text-red-500 mb-4" />
          <h1 className="text-2xl font-bold text-red-400 tracking-wider">ACCOUNT SUSPENDED</h1>
          <p className="mt-2 text-zinc-400">
            This player account has been moderated or suspended in accordance with community security policies.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-4 sm:p-6 font-mono text-white">
      {/* Profile Header */}
      <div className="border border-[#1c2739] bg-[#080c14] p-6 sm:p-8 rounded-lg relative overflow-hidden shadow-2xl">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <span className="text-xs uppercase tracking-widest text-[#37FF1C] font-bold px-2 py-0.5 border border-[#37FF1C]/40 rounded bg-[#37FF1C]/10">
                LEVEL {profile.level}
              </span>
              {profile.isUnknown && (
                <span className="text-xs uppercase tracking-widest text-zinc-400 font-bold px-2 py-0.5 border border-zinc-700 rounded bg-zinc-800/40">
                  ON-CHAIN ONLY
                </span>
              )}
            </div>

            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-wider text-neon-pink">
              {profile.alias ? `@${profile.alias}` : formatShortAddress(profile.address)}
            </h1>

            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <span>WALLET:</span>
              <span className="text-zinc-200">{formatShortAddress(profile.address)}</span>
              <span className="text-zinc-600">•</span>
              <span>JOINED:</span>
              <span className="text-zinc-200">{new Date(profile.joinedAt).toLocaleDateString()}</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleShare}
              className="inline-flex items-center gap-2 border border-neon-pink bg-neon-pink/10 hover:bg-neon-pink/20 text-neon-pink px-4 py-2.5 rounded text-xs font-bold uppercase tracking-widest transition-all"
            >
              {copied ? <Check className="size-4 text-[#37FF1C]" /> : <Share2 className="size-4" />}
              {copied ? "COPIED URL" : "SHARE PROFILE"}
            </button>
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="border border-[#1c2739] bg-[#0d1b2a] p-5 rounded-lg">
          <span className="text-xs text-zinc-400 tracking-widest uppercase">GAMES PLAYED</span>
          <div className="mt-2 text-2xl font-bold text-white">{profile.stats.gamesPlayed}</div>
        </div>

        <div className="border border-[#1c2739] bg-[#0d1b2a] p-5 rounded-lg">
          <span className="text-xs text-zinc-400 tracking-widest uppercase">ARENAS WON</span>
          <div className="mt-2 text-2xl font-bold text-[#37FF1C]">{profile.stats.gamesWon}</div>
        </div>

        <div className="border border-[#1c2739] bg-[#0d1b2a] p-5 rounded-lg">
          <span className="text-xs text-zinc-400 tracking-widest uppercase">WIN RATE</span>
          <div className="mt-2 text-2xl font-bold text-sky-400">{profile.stats.winRate}%</div>
        </div>

        <div className="border border-[#1c2739] bg-[#0d1b2a] p-5 rounded-lg">
          <span className="text-xs text-zinc-400 tracking-widest uppercase">YIELD EARNED</span>
          <div className="mt-2 text-2xl font-bold text-yellow-400">{profile.stats.totalYieldEarned} USDC</div>
        </div>
      </div>

      {/* Achievements Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between border-b border-white/10 pb-2">
          <div className="flex items-center gap-2">
            <Trophy className="size-5 text-yellow-400" />
            <h2 className="text-lg font-bold tracking-wider text-white">ACHIEVEMENTS</h2>
          </div>
          <span className="text-xs text-zinc-400 font-mono">
            {profile.achievements.length} UNLOCKED
          </span>
        </div>

        {profile.achievements.length === 0 ? (
          <div className="border border-dashed border-[#1c2739] p-8 text-center text-sm text-zinc-500 rounded">
            No achievements unlocked yet. Compete in arenas to earn badges!
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {profile.achievements.map((ach) => {
              const style = TIER_STYLES[ach.tier] || TIER_STYLES.bronze;
              return (
                <div
                  key={ach.definitionId}
                  className={`border ${style.border} ${style.bg} p-4 rounded-lg flex flex-col justify-between`}
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <span className={`text-[10px] font-bold uppercase tracking-wider ${style.text}`}>
                        {ach.tier}
                      </span>
                      <Zap className={`size-3.5 ${style.text}`} />
                    </div>
                    <div className="mt-1 font-bold text-sm text-white">{ach.title}</div>
                    <div className="mt-0.5 text-xs text-zinc-400">{ach.description}</div>
                  </div>
                  <div className="mt-3 text-[10px] text-zinc-500">
                    Unlocked {new Date(ach.unlockedAt).toLocaleDateString()}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Match History Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between border-b border-white/10 pb-2">
          <div className="flex items-center gap-2">
            <Swords className="size-5 text-neon-pink" />
            <h2 className="text-lg font-bold tracking-wider text-white">RECENT SETTLED ARENAS</h2>
          </div>
        </div>

        {profile.privacy.hideHistory ? (
          <div className="border border-[#1c2739] bg-[#0d1b2a]/50 p-6 text-center rounded-lg text-zinc-400 text-sm">
            🔒 Match history is hidden by this player's privacy settings.
          </div>
        ) : profile.recentSettledArenas.length === 0 ? (
          <div className="border border-dashed border-[#1c2739] p-6 text-center rounded-lg text-zinc-500 text-sm">
            No recent settled arenas found for this player.
          </div>
        ) : (
          <div className="border border-[#1c2739] bg-[#080c14] divide-y divide-[#1c2739] rounded-lg overflow-hidden">
            {profile.recentSettledArenas.map((arena) => (
              <div key={arena.arenaId} className="flex items-center justify-between p-4 hover:bg-white/[0.02]">
                <div className="space-y-1">
                  <Link
                    href={`/arena/${arena.arenaId}`}
                    className="font-bold text-sm text-white hover:text-neon-pink flex items-center gap-1.5"
                  >
                    {arena.name}
                    <ExternalLink className="size-3 text-zinc-500" />
                  </Link>
                  <div className="text-xs text-zinc-500">
                    Settled on {new Date(arena.settledAt).toLocaleDateString()}
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <span
                    className={`text-xs px-2.5 py-1 rounded font-bold uppercase tracking-wider ${
                      arena.result === "won"
                        ? "border border-[#37FF1C]/40 text-[#37FF1C] bg-[#37FF1C]/10"
                        : arena.result === "eliminated"
                          ? "border border-red-500/40 text-red-400 bg-red-950/20"
                          : "border border-zinc-700 text-zinc-400 bg-zinc-800/20"
                    }`}
                  >
                    {arena.result}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export type PublicPlayerProfileData = PublicProfileData;
