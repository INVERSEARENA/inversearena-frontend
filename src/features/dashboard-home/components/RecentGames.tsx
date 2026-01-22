import type { GameResult } from "../types";

interface RecentGamesProps {
    games: GameResult[];
}

export function RecentGames({ games }: RecentGamesProps) {
    return (
        <div className="border-3 border-[#1c2739] font-mono bg-black/40 p-5">
            {/* Header */}
            <div className="flex items-center gap-2">
                <svg
                    className="size-4 text-zinc-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                </svg>
                <h3 className="text-xs font-bold tracking-widest text-zinc-300">
                    YOUR RECENT GAMES
                </h3>
            </div>

            {/* Games List */}
            <div className="mt-4 space-y-3">
                {games.map((game) => (
                    <div
                        key={game.id}
                        className="flex items-center justify-between text-sm"
                    >
                        <span className="text-zinc-300">{game.arenaName}</span>
                        <div className="flex items-center gap-2">
                            {game.result === "eliminated" ? (
                                <span className="font-bold tracking-wide text-[#FF0055]">
                                    ELIMINATED
                                    {game.round && (
                                        <span className="ml-1 text-zinc-500">R{game.round}</span>
                                    )}
                                </span>
                            ) : (
                                <span className="font-bold tracking-wide text-[#37FF1C]">
                                    WON
                                    {game.prize && (
                                        <span className="ml-1">
                                            {game.prize.toLocaleString()} {game.currency}
                                        </span>
                                    )}
                                </span>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
