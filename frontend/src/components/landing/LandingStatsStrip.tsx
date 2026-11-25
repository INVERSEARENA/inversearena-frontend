import React from "react";
import type { LandingStats } from "@/shared/lib/landingStats";

/**
 * Landing statistics strip (#1626).
 *
 * A Server Component: the figures come from the backend's public
 * `/api/stats/landing` feed, fetched with ISR (see `fetchLandingStats`) so the
 * page is statically served and refreshed at most once a minute. It holds no
 * client state — the numbers are not live ticking values, which is exactly why
 * they can be edge-cached.
 */
const StatItem = ({ label, value, accent }: { label: string; value: string; accent: string }) => (
    <div className="flex flex-col items-start">
        <span className="text-[9px] font-mono tracking-[0.2em] text-zinc-500 uppercase font-bold mb-2">
            {label}
        </span>
        <span className={`text-3xl md:text-4xl font-extralight tracking-tighter family-mono ${accent}`}>
            {value}
        </span>
    </div>
);

const LandingStatsStrip = ({ stats }: { stats: LandingStats }) => {
    return (
        <section
            aria-label="Protocol statistics"
            className="px-6 max-w-7xl mx-auto w-full -mt-4 mb-4"
        >
            <div className="grid grid-cols-2 md:grid-cols-4 gap-8 border-y border-white/5 py-8">
                <StatItem label="ACTIVE ARENAS" value={stats.activeArenas.toLocaleString()} accent="text-neon-green" />
                <StatItem label="TOTAL ARENAS" value={stats.totalArenas.toLocaleString()} accent="text-white" />
                <StatItem label="PLAYERS" value={stats.totalPlayers.toLocaleString()} accent="text-neon-pink" />
                <StatItem
                    label="YIELD ACCRUED"
                    value={`$${Math.round(stats.totalYieldAccrued).toLocaleString()}`}
                    accent="text-white"
                />
            </div>
        </section>
    );
};

export default LandingStatsStrip;
