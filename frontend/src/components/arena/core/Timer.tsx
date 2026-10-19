"use client";

import { useState, useEffect, useCallback } from "react";

interface TimerProps {
  initialSeconds?: number;
  /**
   * Absolute deadline in unix seconds. When set, the countdown is derived from
   * wall-clock time against this deadline (#1552) instead of decrementing
   * `initialSeconds` locally, so the display cannot drift from chain state.
   */
  deadline?: number | null;
  onTimeUp?: () => void;
  label?: string;
}

export function Timer({
  initialSeconds = 300,
  deadline = null,
  onTimeUp,
  label = "Round Ends In",
}: TimerProps) {
  const computeRemaining = useCallback(
    () =>
      deadline === null
        ? initialSeconds
        : Math.max(0, deadline - Math.floor(Date.now() / 1000)),
    [deadline, initialSeconds],
  );

  const [secondsLeft, setSecondsLeft] = useState(computeRemaining);
  const totalSeconds = initialSeconds;

  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsLeft((prev) => {
        if (deadline === null) {
          return prev <= 0 ? 0 : prev - 1;
        }
        return computeRemaining();
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [computeRemaining, deadline]);

  useEffect(() => {
    if (secondsLeft <= 0) {
      onTimeUp?.();
    }
  }, [secondsLeft, onTimeUp]);

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  const progress =
    totalSeconds > 0 ? ((totalSeconds - secondsLeft) / totalSeconds) * 100 : 0;

  const formatTime = (num: number) => num.toString().padStart(2, "0");

  return (
    <div className="bg-white border border-border-gray p-6">
      <p className="text-[10px] font-pixel tracking-[0.2em] text-zinc-500 uppercase mb-4">
        {label}
      </p>

      <div className="font-pixel text-4xl md:text-5xl tracking-wider text-black mb-6">
        {formatTime(minutes)}:{formatTime(seconds)}
      </div>

      {/* Progress bar */}
      <div className="h-3 bg-zinc-200 overflow-hidden">
        <div
          className="h-full bg-neon-pink transition-all duration-1000 ease-linear"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}
