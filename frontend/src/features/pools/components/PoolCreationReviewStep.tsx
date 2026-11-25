"use client";

import type { Currency } from "@/shared/lib/form-validation";
import type { RoundSpeed } from "@/features/pools/model/pool-schema";

interface PoolCreationReviewStepProps {
  stakeAmount: number;
  currency: Currency;
  roundSpeed: RoundSpeed;
  arenaCapacity: number;
  optionCount: 2 | 3;
  onEdit: () => void;
}

export function PoolCreationReviewStep({
  stakeAmount,
  currency,
  roundSpeed,
  arenaCapacity,
  optionCount,
  onEdit,
}: PoolCreationReviewStepProps) {
  return (
    <section className="col-span-12 border-3 border-black bg-[#1e293b] p-5 text-white" aria-labelledby="pool-review-title">
      <h3 id="pool-review-title" className="text-xl font-black uppercase text-primary">Review arena setup</h3>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <div><dt className="text-slate-400">Stake</dt><dd className="font-bold">{stakeAmount} {currency}</dd></div>
        <div><dt className="text-slate-400">Round speed</dt><dd className="font-bold">{roundSpeed}</dd></div>
        <div><dt className="text-slate-400">Seats</dt><dd className="font-bold">{arenaCapacity}</dd></div>
        <div><dt className="text-slate-400">Choices</dt><dd className="font-bold">{optionCount}</dd></div>
      </dl>
      <button type="button" onClick={onEdit} className="mt-4 font-bold underline">Edit setup</button>
    </section>
  );
}
