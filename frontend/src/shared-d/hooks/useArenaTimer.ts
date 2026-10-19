import { useState, useEffect, useRef, useCallback } from 'react';
import { usePageVisibility } from './usePageVisibility';

// Types for the hook
export interface UseArenaTimerOptions {
  initialSeconds: number;
  onTimeUp?: () => void;
  /**
   * Unix timestamp (seconds) at which the commit window closes and the reveal
   * window opens. When either deadline is supplied the hook switches to
   * chain-driven mode and derives `phase` from wall-clock time (#1552).
   */
  commitDeadline?: number | null;
  /**
   * Unix timestamp (seconds) at which the reveal window closes. `0` (or a
   * missing value) means the arena predates the commit/reveal split and the
   * reveal window is unbounded.
   */
  revealDeadline?: number | null;
}

/**
 * Round phase derived purely from the two contract deadlines (#1552):
 * - `commit`   — `now < commitDeadline`
 * - `reveal`   — `commitDeadline <= now < revealDeadline`
 * - `expired`  — `now >= revealDeadline`
 */
export type ArenaTimerPhase = "commit" | "reveal" | "expired";

export interface UseArenaTimerReturn {
  // State values
  rawSeconds: number;
  formattedTime: string;
  progress: number;
  isTensionMode: boolean;
  /** Phase derived from `commitDeadline`/`revealDeadline` (#1552). */
  phase: ArenaTimerPhase;
  /** Absolute deadline (unix seconds) the countdown tracks, or null. */
  activeDeadline: number | null;

  // Control methods
  start: () => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
  sync: (serverSeconds: number) => void;
}

/**
 * Classify the current round phase from the two contract deadlines.
 *
 * Pure and exported so it can be unit-tested independently of React and reused
 * by the backend phase projection (#1552).
 */
export function deriveArenaPhase(
  nowSeconds: number,
  commitDeadline?: number | null,
  revealDeadline?: number | null,
): ArenaTimerPhase {
  const hasReveal = typeof revealDeadline === "number" && revealDeadline > 0;
  if (hasReveal && nowSeconds >= (revealDeadline as number)) {
    return "expired";
  }
  const hasCommit = typeof commitDeadline === "number" && commitDeadline > 0;
  if (hasCommit && nowSeconds >= (commitDeadline as number)) {
    return "reveal";
  }
  return "commit";
}

/**
 * The deadline the countdown should track for the current phase. A reveal
 * window of `0` is unbounded, so the reveal phase reports `null` (no countdown)
 * rather than counting down to the epoch.
 */
export function deriveActiveDeadline(
  phase: ArenaTimerPhase,
  commitDeadline?: number | null,
  revealDeadline?: number | null,
): number | null {
  if (phase === "commit") {
    return typeof commitDeadline === "number" && commitDeadline > 0
      ? commitDeadline
      : null;
  }
  return typeof revealDeadline === "number" && revealDeadline > 0
    ? revealDeadline
    : null;
}

function hasDeadlineInput(
  commitDeadline?: number | null,
  revealDeadline?: number | null,
): boolean {
  return commitDeadline !== undefined || revealDeadline !== undefined;
}

/**
 * Specialized hook for Arena countdown timers with high-precision timing,
 * tension mode detection, and server synchronization capabilities.
 *
 * In chain-driven mode (when either deadline is provided) the hook ignores the
 * manual `start`/`pause`/`resume` controls and derives the countdown and phase
 * from the contract deadlines against wall-clock time, so no phase duration is
 * hardcoded in the client (#1552).
 */
export function useArenaTimer({ 
  initialSeconds, 
  onTimeUp,
  commitDeadline,
  revealDeadline,
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

  // ── Chain-driven phase mode (#1552) ──────────────────────────────────────
  // When either contract deadline is supplied, the countdown and phase come
  // from the chain (wall clock vs. `commitDeadline`/`revealDeadline`) instead
  // of a locally-decremented `initialSeconds`. This is what removes the
  // hardcoded commit/reveal window durations from the client.
  const chainDriven = hasDeadlineInput(commitDeadline, revealDeadline);
  const [clockSeconds, setClockSeconds] = useState(() =>
    Math.floor(Date.now() / 1000),
  );

  useEffect(() => {
    if (!chainDriven) return;
    const tick = () => setClockSeconds(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [chainDriven]);

  const phase: ArenaTimerPhase = chainDriven
    ? deriveArenaPhase(clockSeconds, commitDeadline, revealDeadline)
    : "commit";
  const activeDeadline = chainDriven
    ? deriveActiveDeadline(phase, commitDeadline, revealDeadline)
    : null;
  const deadlineSeconds =
    activeDeadline !== null
      ? Math.max(0, activeDeadline - clockSeconds)
      : Number.MAX_SAFE_INTEGER;
  const displayedSeconds = chainDriven ? deadlineSeconds : rawSeconds;

  const lastFiredDeadlineRef = useRef<number | null>(null);
  useEffect(() => {
    if (!chainDriven || activeDeadline === null || deadlineSeconds > 0) return;
    if (lastFiredDeadlineRef.current === activeDeadline) return;
    lastFiredDeadlineRef.current = activeDeadline;
    onTimeUp?.();
  }, [chainDriven, activeDeadline, deadlineSeconds, onTimeUp]);

  const isTensionMode = chainDriven
    ? displayedSeconds !== Number.MAX_SAFE_INTEGER && displayedSeconds < 30
    : rawSeconds < 30;

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
  const isVisible = usePageVisibility();

  // Single effect owning the interval lifecycle. Previously this was split
  // across two effects (interval lifecycle + page-visibility) that both
  // reacted to `rawSeconds` (which changes ~once per second while running)
  // and both wrote to the same `intervalRef` — the visibility effect had no
  // cleanup of its own, so on every tick it silently overwrote the ref with
  // a second interval, orphaning the first. The orphaned interval kept
  // calling `updateTimer` (which doesn't check `isRunning`) even after
  // `pause()`, since `pause()` can only clear whatever interval the ref
  // currently points to. Consolidating into one effect means there is ever
  // only one interval, and its cleanup always runs before the next one is
  // created.
  useEffect(() => {
    if (isVisible && isRunning && rawSeconds > 0) {
      intervalRef.current = setInterval(updateTimer, 100); // 100ms for high precision
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isVisible, isRunning, rawSeconds, updateTimer]);

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
  // Return the hook API with stable references and computed values
  return {
    // State values
    rawSeconds: displayedSeconds,
    formattedTime:
      displayedSeconds === Number.MAX_SAFE_INTEGER
        ? "--:--"
        : formattedTime(displayedSeconds),
    progress: chainDriven ? 0 : progress(rawSeconds),
    isTensionMode,
    phase,
    activeDeadline,
    
    // Control methods (stable references via useCallback)
    start,
    pause,
    resume,
    reset,
    sync,
  };
}