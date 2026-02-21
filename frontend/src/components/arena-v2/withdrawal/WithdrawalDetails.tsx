"use client";

import { motion } from "framer-motion";

interface WithdrawalDetailsProps {
  totalWithdrawn: string;
  currency?: string;
  destinationAddress: string;
  networkFee: string;
  feeToken?: string;
}

export function WithdrawalDetails({
  totalWithdrawn,
  currency = "USDC",
  destinationAddress,
  networkFee,
  feeToken = "XLM",
}: WithdrawalDetailsProps) {
  const truncatedAddress =
    destinationAddress.length > 8
      ? `${destinationAddress.slice(0, 3)}...${destinationAddress.slice(-4)}`
      : destinationAddress;

  const cards = [
    {
      delay: 0.4,
      className:
        "bg-neon-green/10 border border-neon-green/40 p-4 flex flex-col gap-1 shadow-[6px_6px_0px_0px_#000]",
      content: (
        <>
          <span className="font-mono text-[9px] tracking-widest text-neon-green/60 uppercase">
            Total Withdrawn
          </span>
          <span className="font-black text-xl text-neon-green tracking-wide">
            {totalWithdrawn}{" "}
            <span className="text-sm font-mono text-white/70">{currency}</span>
          </span>
        </>
      ),
    },
    {
      delay: 0.5,
      className:
        "bg-card-bg border border-border-gray p-4 flex flex-col gap-1 shadow-[6px_6px_0px_0px_#000]",
      content: (
        <>
          <span className="font-mono text-[9px] tracking-widest text-white/40 uppercase">
            Destination
          </span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-base text-white tracking-wide">
              {truncatedAddress}
            </span>
            <span className="text-neon-green text-sm">●</span>
          </div>
        </>
      ),
    },
    {
      delay: 0.6,
      className:
        "bg-card-bg border border-border-gray p-4 flex flex-col gap-1 shadow-[6px_6px_0px_0px_#000]",
      content: (
        <>
          <span className="font-mono text-[9px] tracking-widest text-white/40 uppercase">
            Network Fee
          </span>
          <span className="font-mono text-base text-white tracking-wide">
            {networkFee}{" "}
            <span className="text-xs text-white/50">{feeToken}</span>
          </span>
        </>
      ),
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full max-w-2xl">
      {cards.map((card, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: card.delay }}
          className={card.className}
        >
          {card.content}
        </motion.div>
      ))}
    </div>
  );
}
