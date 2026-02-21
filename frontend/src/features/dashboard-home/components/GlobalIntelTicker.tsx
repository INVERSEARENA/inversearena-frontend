import type { IntelItem } from "../types";

interface GlobalIntelTickerProps {
    items: IntelItem[];
}

export function GlobalIntelTicker({ items }: GlobalIntelTickerProps) {
    return (
        <div className="flex items-center gap-4 border-3 border-[#1c2739] font-mono bg-black/40 px-5 py-4">
            {/* Label */}
            <div className="flex shrink-0 items-center gap-2">
                <div className="flex size-6 items-center justify-center rounded-full border border-[#37FF1C]/30 bg-[#37FF1C]/10">
                    <svg
                        className="size-3.5 text-[#37FF1C]"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418"
                        />
                    </svg>
                </div>
                <div>
                    <span className="text-xs font-bold tracking-widest text-white">
                        GLOBAL
                    </span>
                    <br />
                    <span className="text-xs font-bold tracking-widest text-[#37FF1C]">
                        INTEL
                    </span>
                </div>
            </div>

            {/* Separator */}
            <div className="h-8 w-px bg-white/10" />

            {/* Scrolling Ticker */}
            <div className="flex-1 overflow-hidden">
                <div className="flex animate-pulse items-center gap-6">
                    {items.map((item) => (
                        <div
                            key={item.id}
                            className="flex shrink-0 items-center gap-2 text-sm"
                        >
                            {/* Status Dot */}
                            <span
                                className={`size-2 rounded-full ${item.type === "won"
                                    ? "bg-[#37FF1C]"
                                    : item.type === "eliminated"
                                        ? "bg-[#FF0055]"
                                        : "bg-[#37FF1C]"
                                    }`}
                            />

                            {/* Message */}
                            <span className="text-zinc-400">
                                {item.type === "won" && (
                                    <>
                                        <span className="text-[#37FF1C]">{item.message}</span>
                                        <span className="text-zinc-500"> in {item.arenaRef}</span>
                                    </>
                                )}
                                {item.type === "eliminated" && (
                                    <>
                                        <span className="font-mono text-zinc-500">
                                            {item.address}
                                        </span>
                                        <span className="text-[#FF0055]"> {item.message}</span>
                                        <span className="text-zinc-500">
                                            {" "}
                                            from {item.arenaRef}
                                            {item.round && ` (Round ${item.round})`}
                                        </span>
                                    </>
                                )}
                                {item.type === "joined" && (
                                    <>
                                        <span className="font-mono text-zinc-500">
                                            {item.address}
                                        </span>
                                        <span className="text-[#37FF1C]"> {item.message}</span>
                                        <span className="text-zinc-500"> {item.arenaRef}</span>
                                    </>
                                )}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
