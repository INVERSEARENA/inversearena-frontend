"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { Suspense } from "react";
import { motion } from "framer-motion";
import { SuccessHeader } from "@/components/arena-v2/withdrawal/SuccessHeader";
import { UnlockedPadlock } from "@/components/arena-v2/withdrawal/UnlockedPadlock";
import { WithdrawalDetails } from "@/components/arena-v2/withdrawal/WithdrawalDetails";

const STELLAR_EXPERT_BASE = "https://stellar.expert/explorer/public/tx";

function WithdrawalSuccessContent() {
  const params = useSearchParams();
  const router = useRouter();

  const totalWithdrawn = params.get("amount");
  const currency = params.get("currency") ?? "USDC";
  const destinationAddress = params.get("destination");
  const networkFee = params.get("fee") ?? "0.00001";
  const feeToken = params.get("feeToken") ?? "XLM";
  const txHash = params.get("txHash");

  const stellarExpertUrl = txHash
    ? `${STELLAR_EXPERT_BASE}/${txHash}`
    : null;

  const isMissingData = !totalWithdrawn || !destinationAddress || !txHash;

  if (isMissingData) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center px-4 py-12 gap-8">
        <p className="font-mono text-white/50 text-sm tracking-widest uppercase">
          No withdrawal data found.
        </p>
        <button
          onClick={() => router.replace("/")}
          className="bg-neon-green text-black font-black text-sm tracking-[0.2em] uppercase px-10 py-4 hover:bg-neon-green/90 transition-colors shadow-[6px_6px_0px_0px_#000]"
        >
          RETURN TO COMMAND CENTER
        </button>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 py-12 gap-10">
      {/* Header */}
      <SuccessHeader />

      {/* Padlock illustration */}
      <UnlockedPadlock pulse />

      {/* Transaction detail cards */}
      <WithdrawalDetails
        totalWithdrawn={totalWithdrawn}
        currency={currency}
        destinationAddress={destinationAddress}
        networkFee={networkFee}
        feeToken={feeToken}
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

        {stellarExpertUrl && (
          <a
            href={stellarExpertUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[10px] tracking-widest text-white/40 uppercase hover:text-white/70 transition-colors"
          >
            VIEW TRANSACTION ON STELLAREXPERT
          </a>
        )}
      </motion.div>
    </main>
  );
}

export default function WithdrawalSuccessPage() {
  return (
    <Suspense>
      <WithdrawalSuccessContent />
    </Suspense>
  );
}
