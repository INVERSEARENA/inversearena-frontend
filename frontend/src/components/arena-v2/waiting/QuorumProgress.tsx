"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";

interface QuorumProgressProps {
    arenaId?: number;
    currentPlayers?: number;
    requiredPlayers?: number;
    estimatedStart?: string;
    blockHeight?: string;
}

export function QuorumProgress({
    arenaId = 842,
    currentPlayers = 72,
    requiredPlayers = 100,
    estimatedStart = "04:12:09",
    blockHeight = "49,210,123",
}: QuorumProgressProps) {
    const t = useTranslations("lobby");
    const percentage = Math.round((currentPlayers / requiredPlayers) * 100);
    const remaining = requiredPlayers - currentPlayers;

    return (
        <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="neubrutalist-border bg-[#1e293b] p-8 space-y-6"
        >
            {/* Title row */}
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                <div className="space-y-1">
                    <h2 className="text-3xl sm:text-4xl lg:text-5xl font-black tracking-[-0.05em] uppercase font-display text-white">
                        {t("arenaPending", { arenaId })}
                    </h2>
                    <p className="text-primary text-lg lg:text-xl font-bold italic font-display">
                        {t("waitingQuorum", { currentPlayers, requiredPlayers })}
                    </p>
                </div>
                <div className="text-right shrink-0">
                    <span className="text-xs font-bold text-white/50 uppercase tracking-[0.2em] block">
                        {t("estimatedStart")}
                    </span>
                    <p className="text-3xl font-black tabular-nums font-display text-white">
                        {estimatedStart}
                    </p>
                </div>
            </div>

            {/* Progress bar */}
            <div className="space-y-2">
                <div className="flex justify-between items-end">
                    <span className="text-sm font-black uppercase tracking-widest text-white font-display">
                        {t("quorumStatus")}
                    </span>
                    <span className="text-4xl font-black text-primary italic tabular-nums font-display">
                        {percentage}%
                    </span>
                </div>
                <div className="w-full h-12 neubrutalist-border bg-black p-1">
                    <motion.div
                        className="h-full bg-primary"
                        initial={{ width: 0 }}
                        animate={{ width: `${percentage}%` }}
                        transition={{ duration: 1, ease: "easeOut" }}
                    />
                </div>
                <div className="flex justify-between items-start">
                    <span className="text-sm font-bold text-primary font-display">
                        {t("moreParticipants", { remaining })}
                    </span>
                    <span className="text-sm font-bold text-white/40 uppercase font-display">
                        {t("blockHeight", { blockHeight })}
                    </span>
                </div>
            </div>
        </motion.div>
    );
}
