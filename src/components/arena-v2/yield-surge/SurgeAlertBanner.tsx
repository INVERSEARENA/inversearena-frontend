'use client';

import { motion } from 'framer-motion';

export default function SurgeAlertBanner() {
  return (
    <motion.div
      className="relative w-full bg-[#FF0055] py-8 overflow-hidden"
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
    >
      {/* Background pattern with repeated ALERT text */}
      <div className="absolute inset-0 opacity-10 overflow-hidden">
        <div className="flex gap-8 animate-pulse">
          {[...Array(10)].map((_, i) => (
            <span key={i} className="text-white text-xs font-mono tracking-widest whitespace-nowrap">
              ALERT ALERT ALERT ALERT ALERT ALERT
            </span>
          ))}
        </div>
      </div>

      {/* Main alert text with pulsing animation */}
      <motion.h1
        className="relative text-center text-white font-bold italic text-5xl md:text-6xl lg:text-7xl tracking-wider"
        style={{ fontFamily: 'var(--font-space-grotesk)' }}
        animate={{
          textShadow: [
            '0 0 10px rgba(255, 255, 255, 0.5)',
            '0 0 20px rgba(255, 255, 255, 0.8)',
            '0 0 10px rgba(255, 255, 255, 0.5)',
          ],
        }}
        transition={{
          duration: 1.5,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      >
        YIELD_SURGE_DETECTED
      </motion.h1>

      {/* Glitch effect overlay */}
      <motion.div
        className="absolute inset-0 bg-white mix-blend-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 0.1, 0] }}
        transition={{
          duration: 0.2,
          repeat: Infinity,
          repeatDelay: 3,
        }}
      />
    </motion.div>
  );
}
