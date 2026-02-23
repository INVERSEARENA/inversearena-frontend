"use client";

import { motion } from "framer-motion";

interface EntryStatsCardsProps {
    entryStake?: string;
    prizePool?: string;
    rwaLiveYield?: string;
}

export function EntryStatsCards({
    entryStake = "500 XLM",
    prizePool = "50,000 XLM",
    rwaLiveYield = "+2.453 XLM",
}: EntryStatsCardsProps) {
    return (
        <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.3 }}
            className="neubrutalist-border bg-primary p-6 text-black grid grid-cols-1 md:grid-cols-3 gap-6"
        >
            {/* Entry Stake */}
            <div className="space-y-1">
                <p className="text-[10px] font-black uppercase tracking-widest leading-none font-display">
                    ENTRY STAKE
                </p>
                <p className="text-2xl lg:text-3xl font-black italic uppercase font-display">
                    {entryStake}
                </p>
            </div>

            {/* Prize Pool */}
            <div className="space-y-1">
                <p className="text-[10px] font-black uppercase tracking-widest leading-none font-display">
                    PRIZE POOL
                </p>
                <p className="text-2xl lg:text-3xl font-black italic uppercase font-display">
                    {prizePool}
                </p>
            </div>

            {/* RWA Live Yield */}
            <div className="space-y-1 flex flex-col items-start md:items-end">
                <p className="text-[10px] font-black uppercase tracking-widest leading-none font-display md:text-right">
                    RWA LIVE YIELD
                </p>
                <p className="text-2xl lg:text-3xl font-black italic uppercase tabular-nums font-display">
                    {rwaLiveYield}
                </p>
                <span className="text-[10px] font-bold bg-black text-primary px-1 animate-pulse">
                    STAKING ACTIVE
                </span>
            </div>
        </motion.div>
    );
}
