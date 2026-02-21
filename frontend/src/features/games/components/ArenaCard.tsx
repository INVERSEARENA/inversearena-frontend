'use client'
import React, { useState } from 'react';
import { Arena } from '../types';
import JoinArenaModal from '@/components/modals/JoinArenaModal';

interface ArenaCardProps {
    arena: Arena;
}

export const ArenaCard = ({ arena }: ArenaCardProps) => {
    const [isModalOpen, setIsModalOpen] = useState(false);

    const handleJoinClick = () => {
        setIsModalOpen(true);
    };

    const handleCloseModal = () => {
        setIsModalOpen(false);
    };

    const handleConfirmJoin = async () => {
        // Here you would typically handle the logic for joining the arena,
        // like making an API call.
        console.log(`Joining arena ${arena.id}`);
        // Close the modal on successful confirmation
        setIsModalOpen(false);
    };

    if (arena.isFeatured) {
        return (
            <>
                <div className="col-span-1 lg:col-span-2 bg-[#09101D] border border-black p-8 relative overflow-hidden group min-h-[400px]">
                    <div className="absolute top-0 right-0 p-4">
                        <span className="text-[9px] font-mono text-zinc-600 uppercase font-bold px-2 py-1 border border-white/5">ENTRY_STAKE</span>
                        <div className="text-lg font-extralight text-white mt-1">{arena.stake}</div>
                    </div>

                    <div className="flex flex-col h-full justify-between">
                        <div>
                            <span className="text-neon-pink text-[9px] font-bold tracking-[0.2em] uppercase mb-1 block font-mono">HOT_OPERATIONS</span>
                            <h2 className="text-7xl font-extralight tracking-tighter text-white family-mono leading-none mb-8">
                                {arena.number}
                            </h2>

                            <div className="flex gap-10 mb-6 font-mono">
                                <div>
                                    <span className="text-[8px] text-zinc-700 uppercase font-bold block mb-1">PLAYERS_JOINED</span>
                                    <span className="text-lg font-extralight text-white">{arena.playersJoined} / {arena.maxPlayers}</span>
                                </div>
                                <div>
                                    <span className="text-[8px] text-zinc-700 uppercase font-bold block mb-1">ROUND_SPEED</span>
                                    <span className="text-lg font-extralight text-neon-pink">{arena.roundSpeed}</span>
                                </div>
                            </div>

                            <div className="inline-flex items-center gap-3 bg-black/40 border border-white/5 px-3 py-1.5">
                                <div className="w-1.5 h-1.5 bg-neon-green" />
                                <span className="text-[8px] font-mono text-neon-green uppercase font-bold tracking-widest">
                                    LIVE_YIELD: +$12.42 EARNED BY THIS POOL
                                </span>
                            </div>
                        </div>

                        <button
                            onClick={handleJoinClick}
                            className="self-end mt-4 px-12 py-4 bg-neon-green text-black font-bold text-lg uppercase tracking-widest hover:bg-white transition-all transform active:scale-95"
                        >
                            JOIN_POOL
                        </button>
                    </div>
                </div>
                <JoinArenaModal
                    isOpen={isModalOpen}
                    onClose={handleCloseModal}
                    onConfirm={handleConfirmJoin}
                    arenaId={parseInt(arena.number, 10)}
                    requiredStake={parseInt(arena.stake.split(' ')[0], 10)}
                    currentPlayers={arena.playersJoined}
                    maxPlayers={arena.maxPlayers}
                    yieldGeneration={5} // Mock data
                    arenaStatus={arena.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE'}
                />
            </>
        );
    }

    return (
        <>
            <div className="bg-[#09101D] border border-black p-6 flex flex-col justify-between group">
                <div className="flex justify-between items-start mb-8">
                    <h3 className="text-4xl font-extralight tracking-tighter text-white family-mono leading-none">
                        {arena.number}
                    </h3>
                    {arena.badge && (
                        <span className="text-[8px] px-2 py-0.5 bg-neon-pink text-white font-black tracking-widest uppercase">
                            {arena.badge}
                        </span>
                    )}
                </div>

                <div className="space-y-4 mb-8">
                    <div className="pt-3 border-t border-white/5 flex justify-between items-center">
                        <span className="text-[8px] font-mono text-zinc-700 uppercase font-bold tracking-widest">STAKE</span>
                        <span className="text-[10px] font-mono text-white uppercase font-bold">{arena.stake}</span>
                    </div>
                    <div className="pt-3 border-t border-white/5 flex justify-between items-center">
                        <span className="text-[8px] font-mono text-zinc-700 uppercase font-bold tracking-widest">PLAYERS</span>
                        <span className="text-[10px] font-mono text-white uppercase font-bold">{arena.playersJoined}/{arena.maxPlayers}</span>
                    </div>
                    <div className="pt-3 border-t border-white/5 flex justify-between items-center">
                        <span className="text-[8px] font-mono text-zinc-700 uppercase font-bold tracking-widest">
                            {arena.badge ? 'POOL_YIELD' : 'YIELD_TYPE'}
                        </span>
                        <span className="text-[10px] font-mono text-neon-green uppercase font-bold">
                            {arena.badge ? arena.poolYield : 'T-BILLS'}
                        </span>
                    </div>
                </div>

                <button
                    onClick={handleJoinClick}
                    className="w-full py-3.5 bg-neon-green text-black font-bold text-xs uppercase tracking-widest hover:bg-white transition-all"
                >
                    JOIN_POOL
                </button>
            </div>
            <JoinArenaModal
                isOpen={isModalOpen}
                onClose={handleCloseModal}
                onConfirm={handleConfirmJoin}
                arenaId={parseInt(arena.number, 10)}
                requiredStake={parseInt(arena.stake.split(' ')[0], 10)}
                currentPlayers={arena.playersJoined}
                maxPlayers={arena.maxPlayers}
                yieldGeneration={5} // Mock data
                arenaStatus={arena.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE'}
            />
        </>
    );
};
