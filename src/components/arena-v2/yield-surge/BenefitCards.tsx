'use client';

import { motion } from 'framer-motion';
import { Shield, Zap, Unlock } from 'lucide-react';

export default function BenefitCards() {
  const benefits = [
    {
      icon: Shield,
      title: 'ASSET SECURITY',
      description:
        'All fund positions are collateralized via institutional-grade smart contracts on Soroban.',
    },
    {
      icon: Zap,
      title: 'INSTANT YIELD',
      description:
        'Accrued interest is calculated per block and claimable immediately upon surge completion.',
    },
    {
      icon: Unlock,
      title: 'NO LOCKING',
      description:
        'Surge participants can increase stake/stake positions at any time during the event window.',
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      {benefits.map((benefit, index) => {
        const Icon = benefit.icon;
        return (
          <motion.div
            key={index}
            className="bg-[#0D1117] border-2 border-[#1E232B] p-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.5 + index * 0.1 }}
          >
            <div className="flex items-start gap-4">
              {/* Icon */}
              <div className="flex-shrink-0">
                <div className="w-12 h-12 bg-[#1E232B] flex items-center justify-center">
                  <Icon className="w-6 h-6 text-[#37FF1C]" strokeWidth={2} />
                </div>
              </div>

              {/* Content */}
              <div>
                <h3 className="text-[#37FF1C] text-sm font-bold tracking-wider mb-2">
                  {benefit.title}
                </h3>
                <p className="text-gray-400 text-xs leading-relaxed">
                  {benefit.description}
                </p>
              </div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
