"use client";

import { motion } from "framer-motion";
import { SuccessHeader } from "@/components/arena-v2/withdrawal/SuccessHeader";
import { UnlockedPadlock } from "@/components/arena-v2/withdrawal/UnlockedPadlock";
import { WithdrawalDetails } from "@/components/arena-v2/withdrawal/WithdrawalDetails";

// These props would normally come from router state, context, or query params.
// Placeholder values are used here for demonstration.
const MOCK_DATA = {
  totalWithdrawn: "1,240.50",
  currency: "USDC",
  destinationAddress: "GBRXXXXXXK4R2",
  networkFee: "0.00001",
  feeToken: "XLM",
  stellarExpertUrl:
    "https://stellar.expert/explorer/public/tx/placeholder-tx-hash",
};

export default function WithdrawalSuccessPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 py-12 gap-10">
      {/* Header */}
      <SuccessHeader />

      {/* Padlock illustration */}
      <UnlockedPadlock pulse />

      {/* Transaction detail cards */}
      <WithdrawalDetails
        totalWithdrawn={MOCK_DATA.totalWithdrawn}
        currency={MOCK_DATA.currency}
        destinationAddress={MOCK_DATA.destinationAddress}
        networkFee={MOCK_DATA.networkFee}
        feeToken={MOCK_DATA.feeToken}
      />

      {/* CTA button */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.7 }}
        className="flex flex-col items-center gap-4"
      >
        <button
          onClick={() => (window.location.href = "/")}
          className="bg-neon-green text-black font-black text-sm tracking-[0.2em] uppercase px-10 py-4 hover:bg-neon-green/90 transition-colors shadow-[6px_6px_0px_0px_#000]"
        >
          RETURN_TO_COMMAND_CENTER
        </button>

        <a
          href={MOCK_DATA.stellarExpertUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[10px] tracking-widest text-white/40 uppercase hover:text-white/70 transition-colors"
        >
          VIEW TRANSACTION ON STELLAREXPERT
        </a>
      </motion.div>
    </main>
  );
}
