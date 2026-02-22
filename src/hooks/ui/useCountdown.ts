'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

export interface CountdownOptions {
  targetTimestamp?: number;
  durationSeconds?: number;
}

export interface CountdownResult {
  hours: number;
  minutes: number;
  seconds: number;
  display: string;
  isExpired: boolean;
  isPaused: boolean;
  pause: () => void;
  resume: () => void;
}

const pad = (n: number) => n.toString().padStart(2, '0');

function computeRemaining(targetTimestamp: number): number {
  return Math.max(0, Math.floor((targetTimestamp - Date.now()) / 1000));
}

export const useCountdown = (options: CountdownOptions): CountdownResult => {
  const { targetTimestamp, durationSeconds } = options;

  const target = useRef(
    targetTimestamp ?? Date.now() + (durationSeconds ?? 0) * 1000
  );

  const [remaining, setRemaining] = useState(() => computeRemaining(target.current));
  const isPausedRef = useRef(false);
  const [isPaused, setIsPaused] = useState(false);
  const pausedAtRef = useRef<number | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      if (isPausedRef.current) return;

      const left = computeRemaining(target.current);
      setRemaining(left);

      if (left <= 0) clearInterval(interval);
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const pause = useCallback(() => {
    if (isPausedRef.current) return;
    isPausedRef.current = true;
    pausedAtRef.current = Date.now();
    setIsPaused(true);
  }, []);

  const resume = useCallback(() => {
    if (!isPausedRef.current || pausedAtRef.current === null) return;

    // Shift target forward by the paused duration
    const pausedFor = Date.now() - pausedAtRef.current;
    target.current += pausedFor;

    isPausedRef.current = false;
    pausedAtRef.current = null;
    setIsPaused(false);
    setRemaining(computeRemaining(target.current));
  }, []);

  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = remaining % 60;
  const display = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  const isExpired = remaining <= 0;

  return { hours, minutes, seconds, display, isExpired, isPaused, pause, resume };
};
