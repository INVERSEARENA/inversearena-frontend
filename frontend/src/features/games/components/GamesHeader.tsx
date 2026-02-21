import React from 'react';

export const GamesHeader = () => {
    return (
        <div className="mb-8">
            <h1 className="text-4xl font-extralight tracking-tight text-white uppercase italic leading-none">
                ACTIVE <span className="text-neon-green">ARENAS</span>
            </h1>
            <div className="mt-2 flex items-center gap-3">
                <span className="text-[10px] font-mono tracking-[0.3em] text-zinc-500 uppercase font-bold">
                    SCANNING FOR AVAILABLE OPERATIONS...
                </span>
                <div className="flex gap-1">
                    <div className="h-1 w-1 bg-neon-green animate-pulse" />
                    <div className="h-1 w-1 bg-neon-green animate-pulse delay-75" />
                    <div className="h-1 w-1 bg-neon-green animate-pulse delay-150" />
                </div>
            </div>
        </div>
    );
};
