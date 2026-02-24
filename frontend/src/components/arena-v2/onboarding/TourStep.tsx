"use client";

import { type ReactNode } from "react";

interface TourStepProps {
  stepNumber: number;
  totalSteps: number;
  title: string;
  description: ReactNode;
  note?: ReactNode;
  icon: ReactNode;
  isFirst: boolean;
  isLast: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onSkip: () => void;
}

export function TourStep({
  stepNumber,
  totalSteps,
  title,
  description,
  note,
  icon,
  isFirst,
  isLast,
  onPrevious,
  onNext,
  onSkip,
}: TourStepProps) {
  const stepLabel = `STEP ${String(stepNumber).padStart(2, "0")}/${String(totalSteps).padStart(2, "0")}`;

  return (
    <div className="relative w-full max-w-[560px] border-[3px] border-black bg-white text-black shadow-[8px_8px_0_#000]">
      <div className="absolute -top-6 left-4 bg-black px-3 py-1 text-[10px] font-pixel tracking-wider text-white">
        {stepLabel}
      </div>

      <div className="flex items-center justify-between border-b-[3px] border-black px-6 py-4">
        <h3 className="font-pixel text-3xl leading-none uppercase tracking-tight">
          {title}
        </h3>
        <div className="flex h-14 w-14 items-center justify-center border-[3px] border-black bg-[#e9efe8] text-2xl text-black">
          {icon}
        </div>
      </div>

      <div className="space-y-5 px-6 py-5 font-display text-[16px] leading-relaxed">
        <p>{description}</p>

        {note ? (
          <div className="border-l-4 border-neon-green bg-black px-4 py-3 text-sm font-medium text-neon-green">
            {note}
          </div>
        ) : null}
      </div>

      <div className="space-y-3 px-6 pb-5">
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onPrevious}
            disabled={isFirst}
            className="h-12 flex-1 border-[3px] border-black bg-[#efefef] font-pixel text-xs uppercase tracking-wider text-black transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-45"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={onNext}
            className="h-12 flex-1 border-[3px] border-black bg-neon-green font-pixel text-xs uppercase tracking-wider text-black transition hover:brightness-95"
          >
            {isLast ? "Enter Arena" : "Next Step"}
          </button>
        </div>

        <button
          type="button"
          onClick={onSkip}
          className="w-full text-center font-pixel text-[11px] uppercase tracking-[0.2em] text-zinc-500 transition hover:text-black"
        >
          {isLast ? "Skip Tour" : "Skip Quick Tour"}
        </button>
      </div>
    </div>
  );
}
