import type { YieldData } from "../types";

interface YieldGeneratorPanelProps {
    data: YieldData;
}

export function YieldGeneratorPanel({ data }: YieldGeneratorPanelProps) {
    return (
        <div className="border-3 border-[#1c2739] font-mono bg-black/60 p-5">
            {/* Header */}
            <h3 className="text-xs font-bold tracking-widest text-zinc-400">
                YIELD GENERATOR
            </h3>

            {/* Global Yield */}
            <div className="mt-3">
                <div className="text-xs font-medium tracking-wider text-zinc-500">
                    GLOBAL YIELD
                </div>
                <div className="mt-1 text-3xl font-bold text-white">
                    ${data.globalYield.toLocaleString()}
                </div>
            </div>

            {/* APY Badge */}
            <div className="mt-3 flex items-center gap-3">
                <span className="inline-flex items-center rounded border border-[#37FF1C]/30 bg-[#37FF1C]/10 px-2 py-0.5 text-xs font-bold text-[#37FF1C]">
                    +{data.apy}% APY
                </span>
                <span className="text-xs text-zinc-500">{data.sinceLastEpoch}</span>
            </div>

            {/* RWA Allocation */}
            <div className="mt-5 border-t border-white/5 pt-4">
                <div className="flex items-center justify-between text-xs">
                    <span className="font-medium tracking-wider text-zinc-500">
                        RWA ALLOCATION
                    </span>
                    <span className="font-mono text-zinc-400">{data.rwaAllocation}%</span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                    <div
                        className="h-full rounded-full bg-[#37FF1C]/60 transition-all duration-500"
                        style={{ width: `${data.rwaAllocation}%` }}
                    />
                </div>
            </div>
        </div>
    );
}
