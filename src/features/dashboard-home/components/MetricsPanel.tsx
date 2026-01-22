import type { NetworkMetrics } from "../types";

interface MetricsPanelProps {
    metrics: NetworkMetrics;
}

export function MetricsPanel({ metrics }: MetricsPanelProps) {
    const loadPercentage =
        metrics.load === "low" ? 25 : metrics.load === "medium" ? 50 : 85;
    const loadColor =
        metrics.load === "low"
            ? "bg-[#37FF1C]"
            : metrics.load === "medium"
                ? "bg-yellow-400"
                : "bg-[#FF0055]";

    return (
        <div className="border-3 border-[#1c2739] bg-black/40 p-5 font-mono">
            {/* Network Load */}
            <div>
                <div className="flex items-center justify-between text-xs">
                    <span className="font-medium tracking-wider text-zinc-500">
                        NETWORK LOAD
                    </span>
                    <span
                        className={`font-bold tracking-wider ${metrics.load === "low"
                            ? "text-[#37FF1C]"
                            : metrics.load === "medium"
                                ? "text-yellow-400"
                                : "text-[#FF0055]"
                            }`}
                    >
                        {metrics.load.toUpperCase()}
                    </span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                    <div
                        className={`h-full rounded-full transition-all duration-500 ${loadColor}`}
                        style={{ width: `${loadPercentage}%` }}
                    />
                </div>
            </div>

            {/* Separator */}
            <div className="my-4 h-px bg-white/5" />

            {/* Gas Price */}
            <div className="flex items-center justify-between text-xs">
                <span className="font-medium tracking-wider text-zinc-500">
                    GAS PRICE
                </span>
                <span className="font-mono text-zinc-300">
                    {metrics.gasPrice} {metrics.gasCurrency}
                </span>
            </div>
        </div>
    );
}
