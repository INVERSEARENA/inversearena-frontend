import type { ArenaCard } from "../types";

interface FeaturedArenaCardProps {
    arena: ArenaCard;
}

export function FeaturedArenaCard({ arena }: FeaturedArenaCardProps) {
    const progressPercentage = (arena.currentPlayers / arena.maxPlayers) * 100;

    return (
        <div className="relative flex h-full flex-col justify-between font-mono border-3 border-[#1c2739] bg-black/60 p-6">
            {arena.status === "live" && (
                <div className="absolute left-6 top-6">
                    <span className="inline-flex items-center bg-neon-green bg-primary px-2.5 py-1 text-xs font-bold tracking-wide text-black">
                        LIVE NOW
                    </span>
                </div>
            )}

            {/* Top Section */}
            <div className="mt-8">
                <div className="flex items-start justify-between">
                    <h2 className="text-3xl font-bold tracking-tight text-white">
                        {arena.name}
                    </h2>
                    <div className="text-right">
                        <div className="text-xs font-medium tracking-wider text-zinc-400">
                            CURRENT POT
                        </div>
                        <div className="text-3xl font-bold text-white">
                            {arena.currentPot.toLocaleString()}
                        </div>
                        <div className="text-sm font-medium text-zinc-400">
                            {arena.currency}
                        </div>
                    </div>
                </div>

                <p className="mt-4 max-w-md text-sm text-zinc-400">
                    {arena.description}
                </p>
            </div>

            {/* Bottom Section - Progress Bar and CTA */}
            <div className="mt-auto pt-8">
                <div className="flex items-end justify-between gap-6">
                    {/* Players Progress */}
                    <div className="flex-1">
                        <div className="mb-2 flex items-center justify-between text-sm">
                            <span className="font-semibold tracking-wider text-zinc-300">
                                PLAYERS
                            </span>
                            <span className="font-mono text-zinc-300">
                                <span className="text-[#37FF1C]">{arena.currentPlayers}</span>
                                <span className="text-zinc-500"> / {arena.maxPlayers}</span>
                            </span>
                        </div>
                        <div className="h-2.5 w-full overflow-hidden bg-zinc-800">
                            <div
                                className="h-full  bg-[#37FF1C] transition-all duration-500"
                                style={{ width: `${progressPercentage}%` }}
                            />
                        </div>
                        <div className="mt-1.5 flex gap-1">
                            <span className="size-1.5 rounded-full bg-[#37FF1C]" />
                            <span className="size-1.5 rounded-full bg-[#37FF1C]" />
                            <span className="size-1.5 rounded-full bg-[#37FF1C]" />
                        </div>
                    </div>

                    {/* JOIN NOW Button */}
                    <button
                        type="button"
                        className="flex items-center gap-2 rounded-md bg-[#37FF1C] px-6 py-3 text-sm font-bold text-black transition-all hover:bg-[#2be012] hover:shadow-lg hover:shadow-[#37FF1C]/20 focus:outline-none focus:ring-2 focus:ring-[#37FF1C] focus:ring-offset-2 focus:ring-offset-black"
                    >
                        <svg
                            className="size-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2.5}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M13 10V3L4 14h7v7l9-11h-7z"
                            />
                        </svg>
                        JOIN NOW
                    </button>
                </div>
            </div>
        </div>
    );
}
