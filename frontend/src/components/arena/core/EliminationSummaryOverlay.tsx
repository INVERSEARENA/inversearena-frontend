"use client";

import { motion, AnimatePresence } from "framer-motion";

interface EliminationSummaryOverlayProps {
  isOpen: boolean;
  roundsSurvived: number;
  yieldEarned: number;
  isSorobanSynced: boolean;
  vaultStatus: "safe" | "withdrawable" | "processing";
  lockTimeRemaining: number;
  txLedgerUrl?: string;
  onExitToLobby: () => void;
  onJoinNewArena: () => void;
}

export function EliminationSummaryOverlay({
  isOpen,
  roundsSurvived,
  yieldEarned,
  isSorobanSynced,
  vaultStatus,
  lockTimeRemaining,
  txLedgerUrl = "#",
  onExitToLobby,
  onJoinNewArena,
}: EliminationSummaryOverlayProps) {
  const vaultStatusText = {
    safe: "PRINCIPAL SAFE",
    withdrawable: "READY TO WITHDRAW",
    processing: "PROCESSING...",
  };

  const vaultStatusDescription = {
    safe: "RWA integrations fully reconciled for withdrawal.",
    withdrawable: "Funds available for withdrawal",
    processing: "Transaction being processed",
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="fixed inset-0 z-50 bg-[#0f172a] overflow-auto"
        >
          {/* Left pink border accent */}
          <div className="absolute left-0 top-0 bottom-0 w-1 bg-neon-pink" />

          {/* TERMINATED Watermark */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.03 }}
            transition={{ duration: 1, delay: 0.5 }}
            className="absolute inset-0 flex items-center justify-center pointer-events-none overflow-hidden"
          >
            <span className="font-black text-[120px] md:text-[200px] lg:text-[280px] text-white whitespace-nowrap select-none tracking-widest">
              TERMINATED
            </span>
          </motion.div>

          <div className="relative min-h-screen flex flex-col items-center justify-center p-4 md:p-8">
            {/* Banner */}
            <motion.div
              initial={{ y: -100, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ type: "spring", damping: 15, stiffness: 200, delay: 0.2 }}
              className="mb-12"
            >
              <div className="bg-neon-pink px-12 md:px-20 py-6 md:py-8 transform -rotate-2 border-4 border-[#1a1a2e]">
                <h1 className="font-pixel text-xl md:text-3xl lg:text-4xl text-white text-center tracking-wider leading-relaxed">
                  YOU HAVE BEEN<br />ELIMINATED
                </h1>
              </div>
            </motion.div>

            {/* Stats Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6 w-full max-w-4xl mb-8">
              {/* Rounds Survived */}
              <motion.div
                initial={{ y: 50, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.4 }}
                className="bg-[#1e293b] border border-[#334155] p-6 shadow-[6px_6px_0px_0px_#000]"
              >
                <p className="font-pixel text-[8px] text-zinc-400 tracking-wider mb-4">
                  ROUNDS SURVIVED
                </p>
                <div className="flex items-baseline gap-2">
                  <span className="font-pixel text-5xl md:text-6xl text-white">
                    {roundsSurvived}
                  </span>
                  <span className="font-pixel text-lg text-neon-pink">PTS</span>
                </div>
              </motion.div>

              {/* Yield Earned */}
              <motion.div
                initial={{ y: 50, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.5 }}
                className="bg-[#1e293b] border border-[#334155] p-6 shadow-[6px_6px_0px_0px_#000]"
              >
                <p className="font-pixel text-[8px] text-zinc-400 tracking-wider mb-4">
                  YIELD EARNED
                </p>
                <p className="font-pixel text-4xl md:text-5xl text-white mb-3">
                  ${yieldEarned.toFixed(2)}
                </p>
                {isSorobanSynced && (
                  <div className="flex items-center gap-2">
                    <span className="text-neon-green">↗</span>
                    <span className="font-pixel text-[8px] text-neon-green">
                      SOROBAN SYNCED
                    </span>
                  </div>
                )}
              </motion.div>

              {/* Vault Status */}
              <motion.div
                initial={{ y: 50, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.6 }}
                className="bg-[#1e293b] border border-[#334155] p-6 shadow-[6px_6px_0px_0px_#000]"
              >
                <p className="font-pixel text-[8px] text-zinc-400 tracking-wider mb-4">
                  VAULT STATUS
                </p>
                <p className="font-pixel text-xl md:text-2xl text-white mb-2">
                  {vaultStatusText[vaultStatus]}
                </p>
                <p className="text-xs text-zinc-500">
                  {vaultStatusDescription[vaultStatus]}
                </p>
              </motion.div>
            </div>

            {/* Lock Warning Bar */}
            <motion.div
              initial={{ y: 30, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.7 }}
              className="w-full max-w-4xl bg-[#1e293b] border-l-4 border-neon-pink flex flex-col md:flex-row md:items-center md:justify-between gap-4 px-4 py-3 mb-8 shadow-[6px_6px_0px_0px_#000]"
            >
              <div className="flex items-center gap-3">
                <div className="w-5 h-5 rounded-full bg-neon-pink flex items-center justify-center text-white text-xs font-bold">
                  i
                </div>
                <p className="text-sm text-zinc-300 uppercase tracking-wide">
                  Your assets are locked in the settlement layer for{" "}
                  <span className="text-white font-bold">{lockTimeRemaining} more minutes</span>.
                </p>
              </div>
              <a
                href={txLedgerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-pixel text-[10px] text-neon-pink underline whitespace-nowrap"
              >
                VIEW TRANSACTION LEDGER
              </a>
            </motion.div>

            {/* Action Buttons */}
            <motion.div
              initial={{ y: 30, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.8 }}
              className="flex flex-col md:flex-row gap-4 w-full max-w-xl"
            >
              <button
                onClick={onExitToLobby}
                className="flex-1 bg-white text-black font-pixel text-xs py-4 px-8 hover:bg-zinc-200 transition-colors uppercase tracking-wider shadow-[6px_6px_0px_0px_#000]"
              >
                Exit to Lobby
              </button>
              <button
                onClick={onJoinNewArena}
                className="flex-1 bg-neon-pink text-white font-pixel text-xs py-4 px-8 hover:bg-neon-pink/90 transition-colors flex items-center justify-center gap-2 uppercase tracking-wider shadow-[6px_6px_0px_0px_#000]"
              >
                Join New Arena
                <span>⚡</span>
              </button>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
