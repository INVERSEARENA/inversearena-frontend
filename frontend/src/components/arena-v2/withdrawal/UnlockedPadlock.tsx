"use client";

import { motion } from "framer-motion";

interface UnlockedPadlockProps {
  pulse?: boolean;
}

export function UnlockedPadlock({ pulse = true }: UnlockedPadlockProps) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5, delay: 0.2, ease: "easeOut" }}
      className="flex items-center justify-center"
    >
      {/* Outer neon frame */}
      <div className="relative p-3 border-2 border-neon-green/40">
        {/* Middle neon frame */}
        <div className="relative p-3 border-2 border-neon-green/70">
          {/* Inner neon frame */}
          <motion.div
            animate={pulse ? { boxShadow: ["0 0 8px #37FF1C", "0 0 24px #37FF1C", "0 0 8px #37FF1C"] } : {}}
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            className="border-2 border-neon-green p-6 bg-transparent"
          >
            {/* Padlock SVG */}
            <svg
              width="80"
              height="80"
              viewBox="0 0 80 80"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-label="Unlocked padlock"
            >
              {/* Shackle (open/unlocked — shifted right) */}
              <path
                d="M52 36V24C52 14.06 43.94 6 34 6C24.06 6 16 14.06 16 24"
                stroke="#37FF1C"
                strokeWidth="6"
                strokeLinecap="round"
              />
              {/* Lock body */}
              <rect
                x="14"
                y="36"
                width="52"
                height="38"
                rx="4"
                fill="#37FF1C"
              />
              {/* Keyhole circle */}
              <circle cx="40" cy="52" r="6" fill="#09101D" />
              {/* Keyhole stem */}
              <rect x="37" y="54" width="6" height="8" rx="1" fill="#09101D" />
            </svg>
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}
