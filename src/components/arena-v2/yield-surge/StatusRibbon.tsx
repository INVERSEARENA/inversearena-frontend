'use client';

import { motion } from 'framer-motion';

export default function StatusRibbon() {
  const stats = [
    { label: 'NETWORK_STATUS', value: 'OPTIMAL', highlight: true },
    { label: 'BLOCK_HEIGHT', value: '12,432,812', highlight: false },
    { label: 'TOTAL_VAL_LOCKED', value: '$42,689,123.96', highlight: false },
    { label: 'EVENT_ID', value: 'SURGE_ALPHA_02', highlight: false },
    { label: 'SOROBAN', value: 'v21.3.0', highlight: false },
  ];

  return (
    <motion.div
      className="bg-[#0D1117] border-y-2 border-[#1E232B] py-3 px-6 overflow-x-auto"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.4 }}
    >
      <div className="flex items-center justify-between gap-6 min-w-max">
        {stats.map((stat, index) => (
          <div key={index} className="flex items-center gap-2">
            <span className="text-gray-500 text-xs font-mono tracking-wider">
              {stat.label}:
            </span>
            <span
              className={`text-xs font-mono font-bold tracking-wider ${
                stat.highlight ? 'text-[#37FF1C]' : 'text-white'
              }`}
            >
              {stat.value}
            </span>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
