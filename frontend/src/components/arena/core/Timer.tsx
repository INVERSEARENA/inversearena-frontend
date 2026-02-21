"use client";

import { useState, useEffect } from "react";

interface TimerProps {
  initialSeconds?: number;
  onTimeUp?: () => void;
}

export function Timer({ initialSeconds = 300, onTimeUp }: TimerProps) {
  const [secondsLeft, setSecondsLeft] = useState(initialSeconds);
  const totalSeconds = initialSeconds;

  useEffect(() => {
    if (secondsLeft <= 0) {
      onTimeUp?.();
      return;
    }

    const interval = setInterval(() => {
      setSecondsLeft((prev) => prev - 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [secondsLeft, onTimeUp]);

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  const progress = ((totalSeconds - secondsLeft) / totalSeconds) * 100;

  const formatTime = (num: number) => num.toString().padStart(2, "0");

  return (
    <div className="bg-white border border-border-gray p-6">
      <p className="text-[10px] font-pixel tracking-[0.2em] text-zinc-500 uppercase mb-4">
        Round Ends In
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
