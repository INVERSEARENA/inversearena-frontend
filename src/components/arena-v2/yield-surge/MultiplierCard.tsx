'use client';

import { motion } from 'framer-motion';

export default function MultiplierCard() {
  const progress = 65; // Current progress percentage

  return (
    <motion.div
      className="bg-black border-2 border-[#1E232B] p-8"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5, delay: 0.2 }}
    >
      {/* Current Multiplier Label */}
      <div className="mb-6">
        <p className="text-[#37FF1C] text-sm font-mono tracking-widest mb-4">
          CURRENT_MULTIPLIER
        </p>

        {/* Large 2x Display */}
        <motion.div
          className="text-white text-8xl font-bold"
          style={{
            fontFamily: 'var(--font-space-grotesk)',
            textShadow: '0 0 20px rgba(55, 255, 28, 0.6), 4px 4px 0px rgba(55, 255, 28, 0.3)',
          }}
          animate={{
            textShadow: [
              '0 0 20px rgba(55, 255, 28, 0.6), 4px 4px 0px rgba(55, 255, 28, 0.3)',
              '0 0 30px rgba(55, 255, 28, 0.8), 4px 4px 0px rgba(55, 255, 28, 0.5)',
              '0 0 20px rgba(55, 255, 28, 0.6), 4px 4px 0px rgba(55, 255, 28, 0.3)',
            ],
          }}
          transition={{
            duration: 2,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        >
          2<span className="text-6xl">x</span>
        </motion.div>
      </div>

      {/* Segmented Progress Bar */}
      <div className="space-y-2">
        <div className="flex gap-1">
          {[...Array(20)].map((_, i) => {
            const segmentFilled = (i / 20) * 100 < progress;
            return (
              <motion.div
                key={i}
                className={`flex-1 h-3 ${
                  segmentFilled ? 'bg-[#37FF1C]' : 'bg-[#1E232B]'
                }`}
                initial={{ opacity: 0, scaleX: 0 }}
                animate={{ opacity: 1, scaleX: 1 }}
                transition={{ duration: 0.3, delay: 0.3 + i * 0.02 }}
                style={{
                  boxShadow: segmentFilled
                    ? '0 0 10px rgba(55, 255, 28, 0.5)'
                    : 'none',
                }}
              />
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}
