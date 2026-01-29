import { useState, useEffect, useRef, useCallback } from 'react';

// Types for the hook
export interface UseArenaTimerOptions {
  initialSeconds: number;
  onTimeUp?: () => void;
}

export interface UseArenaTimerReturn {
  // State values
  rawSeconds: number;
  formattedTime: string;
  progress: number;
  isTensionMode: boolean;
  
  // Control methods
  start: () => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
  sync: (serverSeconds: number) => void;
}

/**
 * Specialized hook for Arena countdown timers with high-precision timing,
 * tension mode detection, and server synchronization capabilities.
 */
export function useArenaTimer({ 
  initialSeconds, 
  onTimeUp 
}: UseArenaTimerOptions): UseArenaTimerReturn {
  // Core state
  const [rawSeconds, setRawSeconds] = useState(initialSeconds);
  const [isRunning, setIsRunning] = useState(false);
  
  // Refs for interval management and timing precision
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const lastUpdateRef = useRef<number | null>(null);
  // Derived state calculations
  const formattedTime = useCallback((seconds: number): string => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  }, []);

  const progress = useCallback((current: number): number => {
    return Math.max(0, Math.min(100, ((initialSeconds - current) / initialSeconds) * 100));
  }, [initialSeconds]);

  const isTensionMode = rawSeconds < 30;

  // High-precision timer update function using Date.now() for resilience
  const updateTimer = useCallback(() => {
    if (!startTimeRef.current || !lastUpdateRef.current) return;

    const now = Date.now();
    const elapsed = Math.floor((now - startTimeRef.current) / 1000);
    const newSeconds = Math.max(0, initialSeconds - elapsed);

    setRawSeconds(newSeconds);
    lastUpdateRef.current = now;

    // Execute onTimeUp callback when timer reaches zero
    if (newSeconds === 0 && onTimeUp) {
      onTimeUp();
    }
  }, [initialSeconds, onTimeUp]);