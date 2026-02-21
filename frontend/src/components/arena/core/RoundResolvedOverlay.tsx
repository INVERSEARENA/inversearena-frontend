"use client";

import React, { useEffect, useRef, useState } from "react";

const backdrop: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};

const container: Variants = {
  hidden: { opacity: 0, scale: 0.98 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { type: "spring" as const, stiffness: 260, damping: 25 },
  },
main
};

const cardVariants = {
  hidden: { opacity: 0, y: 24 },
  visible: (i = 0) => ({ opacity: 1, y: 0, transition: { delay: i * 0.1 } }),
};

export const RoundResolvedOverlay: React.FC<RoundResolvedOverlayProps> = ({
  isOpen = false,
  status,
  roundNumber,
  livePopulation,
  totalPopulation,
  eliminatedPercent,
  currentPot,
  potGrowth,
  majorityChoice,
  txHash,
  onProceed,
}) => {
  const [holding, setHolding] = useState(false);
  const holdTimer = useRef<number | null>(null);
  const holdProgress = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      if (holdTimer.current) window.clearTimeout(holdTimer.current);
    };
  }, []);

  const startHold = () => {
    setHolding(true);
    if (holdProgress.current) holdProgress.current.style.width = "0%";
    let start = Date.now();
    const tick = () => {
      const elapsed = Date.now() - start;
      const pct = Math.min(100, (elapsed / 1000) * 100);
      if (holdProgress.current) holdProgress.current.style.width = `${pct}%`;
      if (elapsed >= 1000) {
        setHolding(false);
        onProceed();
      } else {
        holdTimer.current = window.setTimeout(tick, 16) as unknown as number;
      }
    };
    holdTimer.current = window.setTimeout(tick, 16) as unknown as number;
  };

  const cancelHold = () => {
    setHolding(false);
    if (holdTimer.current) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (holdProgress.current) holdProgress.current.style.width = "0%";
  };

  const isSurvived = status === "survived";

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          key="round-resolved-backdrop"
          className="fixed inset-0 z-50 flex items-center justify-center"
          variants={backdrop}
          initial="hidden"
          animate="visible"
          exit="hidden"
        >
          <motion.div className="absolute inset-0 bg-black/80" aria-hidden />

          <motion.div
            className="relative w-full max-w-6xl mx-4 md:mx-8 lg:mx-0 p-6 md:p-10 rounded-lg border border-white/5 bg-[rgb(10,10,10)]"
            variants={container}
            initial="hidden"
            animate="visible"
            exit="hidden"
          >
            <div className="text-center mb-6">
              <div className="font-mono text-[10px] text-white/60 tracking-wider">ROUND {roundNumber}: RESOLVED</div>
              <motion.h2
                className={`mt-4 font-pixel text-5xl md:text-6xl leading-none ${isSurvived ? "text-neon-green" : "text-neon-pink"}`}
                animate={{ opacity: [0.9, 1, 0.9], filter: ["brightness(1)", "brightness(1.2)", "brightness(1)"] }}
                transition={{ duration: 2, repeat: Infinity }}
              >
                {isSurvived ? "YOU SURVIVED" : "YOU ARE ELIMINATED"}
              </motion.h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <motion.div custom={0} variants={cardVariants} initial="hidden" animate="visible" className="bg-card-bg p-5 rounded-lg border border-neon-green/20">
                <p className="font-pixel text-[10px] text-white/60 tracking-wider mb-2">LIVE POPULATION</p>
                <div className="flex items-baseline gap-3">
                  <div className="font-pixel text-4xl text-white">{livePopulation}</div>
                  <div className="font-pixel text-xl text-white/40">/{totalPopulation}</div>
                </div>
                <p className="mt-3 text-sm text-neon-pink">-{eliminatedPercent}% ELIMINATED</p>
              </motion.div>

              <motion.div custom={1} variants={cardVariants} initial="hidden" animate="visible" className="bg-card-bg p-5 rounded-lg border border-neon-green/20">
                <p className="font-pixel text-[10px] text-white/60 tracking-wider mb-2">CURRENT POT (RWA YIELD)</p>
                <div className="flex items-baseline gap-3">
                  <div className="font-pixel text-4xl text-white">${currentPot.toLocaleString()}</div>
                </div>
                <p className="mt-3 text-sm text-neon-green">+{potGrowth}% GROWTH</p>
              </motion.div>

              <motion.div custom={2} variants={cardVariants} initial="hidden" animate="visible" className="bg-card-bg p-5 rounded-lg border border-white/5 flex flex-col justify-center items-center">
                <p className="font-pixel text-[10px] text-white/60 tracking-wider mb-2">MAJORITY CHOICE</p>
                <div className="text-4xl font-pixel text-white/80 uppercase tracking-wider">{majorityChoice.toUpperCase()}</div>
                <div className="mt-4 w-full bg-black/20 rounded h-14 flex items-center justify-center">
                  <span className={`px-4 py-1 font-bold ${isSurvived ? "bg-neon-green text-black" : "bg-neon-pink text-white"} rounded`}>{isSurvived ? "ELIMINATED" : "ELIMINATED"}</span>
                </div>
              </motion.div>
            </div>

            <div className="mb-6">
              <div className="w-full rounded-md overflow-hidden bg-neon-green/5">
                <div className="bg-neon-green px-6 py-3 flex justify-between items-center">
                  <div className="font-pixel text-sm text-black/90">VERIFICATION: MINORITY CONSENSUS ACHIEVED</div>
                  <div className="font-mono text-xs text-black/80">{txHash}</div>
                </div>
              </div>
            </div>

            <div className="flex flex-col items-center gap-4">
              <div
                role="button"
                aria-label="Hold for survival"
                onPointerDown={startHold}
                onPointerUp={cancelHold}
                onPointerLeave={cancelHold}
                onTouchStart={startHold}
                onTouchEnd={cancelHold}
                className="relative w-64 md:w-96 bg-neon-green text-black font-pixel text-lg py-4 rounded-md cursor-pointer select-none flex items-center justify-center"
              >
                HOLD FOR SURVIVAL
                <div className="absolute left-0 bottom-0 h-1 bg-black/20 w-full">
                  <div ref={holdProgress} className="h-full bg-black" style={{ width: 0 }} />
                </div>
              </div>

              <div className="text-[10px] font-mono text-white/50">Prepare for next round</div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default RoundResolvedOverlay;
