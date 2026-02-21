"use client";

import { usePolling } from "@/shared-d/hooks/usePolling";
import { fetchNetworkStats } from "@/shared-d/mocks/mockNetworkStats";

export function MetricsPanel() {
    const { data: stats, status } = usePolling(fetchNetworkStats, {
        intervalMs: 5000,
        enabled: true,
    });

    const load = stats?.networkLoad || "low";
    const gasPrice = stats?.gasPrice || 0;
    const gasCurrency = stats?.gasCurrency || "GWEI";

    const loadPercentage = load === "low" ? 25 : load === "medium" ? 50 : 85;
    const loadColor =
        load === "low" ? "bg-[#37FF1C]" : load === "medium" ? "bg-yellow-400" : "bg-[#FF0055]";
    const loadTextColor =
        load === "low" ? "text-[#37FF1C]" : load === "medium" ? "text-yellow-400" : "text-[#FF0055]";

    return (
        <div className="border-3 border-[#1c2739] bg-black/40 p-5 font-mono">
            <div>
                <div className="flex items-center justify-between text-xs">
                    <span className="font-medium tracking-wider text-zinc-500">
                        NETWORK LOAD
                    </span>
                    <span className={`font-bold tracking-wider ${loadTextColor}`}>
                        {status === "loading" && !stats ? "..." : load.toUpperCase()}
                    </span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                    <div
                        className={`h-full rounded-full transition-all duration-500 ${loadColor}`}
                        style={{ width: `${loadPercentage}%` }}
                    />
                </div>
            </div>

            <div className="my-4 h-px bg-white/5" />

            <div className="flex items-center justify-between text-xs">
                <span className="font-medium tracking-wider text-zinc-500">
                    GAS PRICE
                </span>
                <span className="font-mono text-zinc-300">
                    {status === "loading" && !stats ? "..." : `${gasPrice} ${gasCurrency}`}
                </span>
            </div>
        </div>
    );
}
