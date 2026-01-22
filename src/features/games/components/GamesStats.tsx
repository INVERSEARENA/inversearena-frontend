import React from 'react';

export const GamesStats = () => {
    return (
        <div className="flex gap-12 bg-black/40 border border-white/5 p-6 backdrop-blur-sm self-start">
            <div className="flex flex-col">
                <span className="text-[9px] font-mono tracking-[0.2em] text-zinc-500 uppercase font-bold mb-2">
                    GLOBAL_POOL_TOTAL
                </span>
                <span className="text-3xl font-extralight tracking-tighter text-neon-green family-mono">
                    $1,429,082
                </span>
            </div>
            <div className="flex flex-col">
                <span className="text-[9px] font-mono tracking-[0.2em] text-zinc-500 uppercase font-bold mb-2">
                    LIVE_SURVIVORS
                </span>
                <span className="text-3xl font-extralight tracking-tighter text-neon-pink family-mono">
                    12,842
                </span>
            </div>
        </div>
    );
};
