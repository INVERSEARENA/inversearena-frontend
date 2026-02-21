"use client";

import { usePolling } from '@/shared-d/hooks/usePolling';
import { fetchNetworkStats } from '@/shared-d/mocks/mockNetworkStats';

export const GamesStats = () => {
    const { data: stats, status } = usePolling(fetchNetworkStats, {
        intervalMs: 5000,
        enabled: true,
    });

    const globalPoolTotal = stats?.globalPoolTotal || 0;
    const liveSurvivors = stats?.liveSurvivors || 0;

    return (
        <div className="flex gap-12 bg-black/40 border border-white/5 p-6 backdrop-blur-sm self-start">
            <div className="flex flex-col">
                <span className="text-[9px] font-mono tracking-[0.2em] text-zinc-500 uppercase font-bold mb-2">
                    GLOBAL_POOL_TOTAL
                </span>
                <span className="text-3xl font-extralight tracking-tighter text-neon-green family-mono">
                    {status === 'loading' && !stats ? '...' : `$${globalPoolTotal.toLocaleString()}`}
                </span>
            </div>
            <div className="flex flex-col">
                <span className="text-[9px] font-mono tracking-[0.2em] text-zinc-500 uppercase font-bold mb-2">
                    LIVE_SURVIVORS
                </span>
                <span className="text-3xl font-extralight tracking-tighter text-neon-pink family-mono">
                    {status === 'loading' && !stats ? '...' : liveSurvivors.toLocaleString()}
                </span>
            </div>
        </div>
    );
};
