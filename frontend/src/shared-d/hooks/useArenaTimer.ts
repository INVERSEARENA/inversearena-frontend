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
  // Timer control methods with stable references
  const start = useCallback(() => {
    if (isRunning) return;
    
    const now = Date.now();
    startTimeRef.current = now - (initialSeconds - rawSeconds) * 1000;
    lastUpdateRef.current = now;
    setIsRunning(true);
  }, [isRunning, initialSeconds, rawSeconds]);

  const pause = useCallback(() => {
    if (!isRunning) return;
    
    setIsRunning(false);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, [isRunning]);

  const resume = useCallback(() => {
    if (isRunning) return;
    
    const now = Date.now();
    startTimeRef.current = now - (initialSeconds - rawSeconds) * 1000;
    lastUpdateRef.current = now;
    setIsRunning(true);
  }, [isRunning, initialSeconds, rawSeconds]);
  const reset = useCallback(() => {
    setIsRunning(false);
    setRawSeconds(initialSeconds);
    startTimeRef.current = null;
    lastUpdateRef.current = null;
    
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, [initialSeconds]);

  // Server synchronization method (mock implementation for now)
  const sync = useCallback((serverSeconds: number) => {
    // Validate server seconds
    if (serverSeconds < 0 || serverSeconds > initialSeconds) {
      console.warn('useArenaTimer: Invalid server seconds provided for sync');
      return;
    }
    
    setRawSeconds(serverSeconds);
    
    // If timer is running, adjust the start time reference
    if (isRunning) {
      const now = Date.now();
      startTimeRef.current = now - (initialSeconds - serverSeconds) * 1000;
      lastUpdateRef.current = now;
    }
  }, [initialSeconds, isRunning]);
  // Effect to manage the interval lifecycle
  useEffect(() => {
    if (isRunning && rawSeconds > 0) {
      intervalRef.current = setInterval(updateTimer, 100); // 100ms for high precision
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    // Cleanup on unmount or when dependencies change
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isRunning, rawSeconds, updateTimer]);

  // Effect to handle timer completion
  useEffect(() => {
    if (rawSeconds === 0 && isRunning) {
      setIsRunning(false);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
  }, [rawSeconds, isRunning]);
  // Page visibility handling for resilience during tab switching
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Tab is hidden - pause updates but keep timing reference
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } else {
        // Tab is visible again - resume updates if timer was running
        if (isRunning && rawSeconds > 0) {
          updateTimer(); // Immediate update to catch up
          intervalRef.current = setInterval(updateTimer, 100);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isRunning, rawSeconds, updateTimer]);
  // Return the hook API with stable references and computed values
  return {
    // State values
    rawSeconds,
    formattedTime: formattedTime(rawSeconds),
    progress: progress(rawSeconds),
    isTensionMode,
    
    // Control methods (stable references via useCallback)
    start,
    pause,
    resume,
    reset,
    sync,
  };
}