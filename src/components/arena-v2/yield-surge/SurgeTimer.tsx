'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';

interface SurgeTimerProps {
  initialSeconds?: number;
}

export default function SurgeTimer({ initialSeconds = 10000 }: SurgeTimerProps) {
  const [timeRemaining, setTimeRemaining] = useState(initialSeconds);

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeRemaining((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const hours = Math.floor(timeRemaining / 3600);
  const minutes = Math.floor((timeRemaining % 3600) / 60);
  const seconds = timeRemaining % 60;

  const formatTime = (value: number) => value.toString().padStart(2, '0');

  return (
    <motion.div
      className="bg-[#0D1117] border-2 border-[#1E232B] p-6"
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.5, delay: 0.3 }}
    >
      {/* Announcement Box */}
      <div className="bg-white p-4 mb-6 flex items-start gap-3">
        <div className="flex-shrink-0 mt-1">
          <div className="w-6 h-6 bg-black flex items-center justify-center">
            <span className="text-white text-sm font-bold">i</span>
          </div>
        </div>
        <p className="text-black font-bold text-sm tracking-wide leading-relaxed">
          ALL STAKES IN NEON ARENA NOW EARN DOUBLE RWA INTEREST.
        </p>
      </div>

      {/* Timer Section */}
      <div>
        <p className="text-[#FF0055] text-xs font-mono tracking-widest mb-3">
          TIME_REMAINING
        </p>

        <div className="flex items-center justify-between gap-3 mb-6">
          {/* Hours */}
          <motion.div
            className="flex flex-col items-center"
            animate={{ opacity: [1, 0.7, 1] }}
            transition={{ duration: 1, repeat: Infinity }}
          >
            <div className="text-white text-5xl font-mono font-bold tabular-nums">
              {formatTime(hours)}
            </div>
            <span className="text-gray-500 text-xs font-mono mt-1">HOURS</span>
          </motion.div>

          <span className="text-white text-4xl font-bold mb-6">:</span>

          {/* Minutes */}
          <motion.div
            className="flex flex-col items-center"
            animate={{ opacity: [1, 0.7, 1] }}
            transition={{ duration: 1, repeat: Infinity, delay: 0.3 }}
          >
            <div className="text-white text-5xl font-mono font-bold tabular-nums">
              {formatTime(minutes)}
            </div>
            <span className="text-gray-500 text-xs font-mono mt-1">MINS</span>
          </motion.div>

          <span className="text-white text-4xl font-bold mb-6">:</span>

          {/* Seconds */}
          <motion.div
            className="flex flex-col items-center"
            animate={{ opacity: [1, 0.7, 1] }}
            transition={{ duration: 1, repeat: Infinity, delay: 0.6 }}
          >
            <div className="text-white text-5xl font-mono font-bold tabular-nums">
              {formatTime(seconds)}
            </div>
            <span className="text-gray-500 text-xs font-mono mt-1">SECS</span>
          </motion.div>
        </div>

        {/* Deploy Now Button */}
        <motion.button
          className="w-full bg-[#37FF1C] text-black font-bold text-lg py-4 px-6 tracking-wider hover:bg-[#2ee015] transition-colors"
          style={{ fontFamily: 'var(--font-space-grotesk)' }}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
        >
          DEPLOY_NOW
        </motion.button>
      </div>
    </motion.div>
  );
}
