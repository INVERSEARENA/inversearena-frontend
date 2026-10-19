import { renderHook, act } from '@testing-library/react';
import {
  useArenaTimer,
  deriveArenaPhase,
  deriveActiveDeadline,
} from '../useArenaTimer';

let mockIsVisible = true;
jest.mock('../usePageVisibility', () => ({
  usePageVisibility: () => mockIsVisible,
}));

describe('useArenaTimer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockIsVisible = true;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('returns initial state correctly', () => {
    const { result } = renderHook(() =>
      useArenaTimer({ initialSeconds: 120 })
    );
    expect(result.current.rawSeconds).toBe(120);
    expect(result.current.formattedTime).toBe('02:00');
    expect(result.current.progress).toBe(0);
    expect(result.current.isTensionMode).toBe(false);
  });

  it('activates tension mode when under 30 seconds', () => {
    const { result } = renderHook(() =>
      useArenaTimer({ initialSeconds: 20 })
    );
    expect(result.current.isTensionMode).toBe(true);
  });

  it('formats time with zero-padded minutes and seconds', () => {
    const { result } = renderHook(() =>
      useArenaTimer({ initialSeconds: 65 })
    );
    expect(result.current.formattedTime).toBe('01:05');
  });

  it('start() begins countdown', () => {
    const { result } = renderHook(() =>
      useArenaTimer({ initialSeconds: 10 })
    );

    act(() => { result.current.start(); });
    act(() => { jest.advanceTimersByTime(2000); });

    expect(result.current.rawSeconds).toBeLessThan(10);
  });

  it('pause() stops the countdown', () => {
    const { result } = renderHook(() =>
      useArenaTimer({ initialSeconds: 10 })
    );

    act(() => { result.current.start(); });
    act(() => { jest.advanceTimersByTime(1000); });
    const secondsAfterPause = result.current.rawSeconds;
    act(() => { result.current.pause(); });
    act(() => { jest.advanceTimersByTime(2000); });

    expect(result.current.rawSeconds).toBe(secondsAfterPause);
  });

  it('resume() continues after pause', () => {
    const { result } = renderHook(() =>
      useArenaTimer({ initialSeconds: 10 })
    );

    act(() => { result.current.start(); });
    act(() => { jest.advanceTimersByTime(1000); });
    act(() => { result.current.pause(); });
    const secondsAfterPause = result.current.rawSeconds;

    act(() => { result.current.resume(); });
    act(() => { jest.advanceTimersByTime(2000); });

    expect(result.current.rawSeconds).toBeLessThan(secondsAfterPause);
  });

  it('reset() restores initial state', () => {
    const { result } = renderHook(() =>
      useArenaTimer({ initialSeconds: 10 })
    );

    act(() => { result.current.start(); });
    act(() => { jest.advanceTimersByTime(3000); });
    act(() => { result.current.reset(); });

    expect(result.current.rawSeconds).toBe(10);
    expect(result.current.formattedTime).toBe('00:10');
  });

  it('sync() updates rawSeconds while running', () => {
    const { result } = renderHook(() =>
      useArenaTimer({ initialSeconds: 60 })
    );

    act(() => { result.current.start(); });
    act(() => { result.current.sync(45); });

    expect(result.current.rawSeconds).toBe(45);
  });

  it('sync() ignores out-of-range values', () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() =>
      useArenaTimer({ initialSeconds: 60 })
    );

    act(() => { result.current.sync(100); });
    expect(result.current.rawSeconds).toBe(60);

    act(() => { result.current.sync(-1); });
    expect(result.current.rawSeconds).toBe(60);

    consoleSpy.mockRestore();
  });

  it('calls onTimeUp when timer reaches zero', () => {
    const onTimeUp = jest.fn();
    const { result } = renderHook(() =>
      useArenaTimer({ initialSeconds: 1, onTimeUp })
    );

    act(() => { result.current.start(); });
    act(() => { jest.advanceTimersByTime(2000); });

    expect(onTimeUp).toHaveBeenCalled();
  });

  it('clears interval when tab becomes hidden', () => {
    const { result, rerender } = renderHook(() =>
      useArenaTimer({ initialSeconds: 30 })
    );

    act(() => { result.current.start(); });
    act(() => { jest.advanceTimersByTime(500); });

    mockIsVisible = false;
    rerender();

    const secondsWhenHidden = result.current.rawSeconds;
    act(() => { jest.advanceTimersByTime(3000); });

    expect(result.current.rawSeconds).toBe(secondsWhenHidden);
  });

  it('resumes interval when tab becomes visible again', () => {
    const { result, rerender } = renderHook(() =>
      useArenaTimer({ initialSeconds: 30 })
    );

    act(() => { result.current.start(); });
    mockIsVisible = false;
    rerender();

    const secondsWhenHidden = result.current.rawSeconds;

    mockIsVisible = true;
    rerender();
    act(() => { jest.advanceTimersByTime(2000); });

    expect(result.current.rawSeconds).toBeLessThan(secondsWhenHidden);
  });
});

describe('deriveArenaPhase (#1552)', () => {
  it('classifies each phase window', () => {
    expect(deriveArenaPhase(100, 200, 300)).toBe('commit');
    expect(deriveArenaPhase(200, 200, 300)).toBe('reveal');
    expect(deriveArenaPhase(250, 200, 300)).toBe('reveal');
    expect(deriveArenaPhase(300, 200, 300)).toBe('expired');
    expect(deriveArenaPhase(400, 200, 300)).toBe('expired');
  });

  it('keeps legacy arenas (reveal deadline 0) in reveal after the commit deadline', () => {
    expect(deriveArenaPhase(100, 50, 0)).toBe('reveal');
  });

  it('stays in commit when no deadlines are supplied', () => {
    expect(deriveArenaPhase(100, null, null)).toBe('commit');
  });
});

describe('deriveActiveDeadline (#1552)', () => {
  it('tracks the commit deadline during commit', () => {
    expect(deriveActiveDeadline('commit', 200, 300)).toBe(200);
  });

  it('tracks the reveal deadline during reveal and expiry', () => {
    expect(deriveActiveDeadline('reveal', 200, 300)).toBe(300);
    expect(deriveActiveDeadline('expired', 200, 300)).toBe(300);
  });

  it('reports no countdown for an unbounded (legacy) reveal window', () => {
    expect(deriveActiveDeadline('reveal', 200, 0)).toBeNull();
  });
});

describe('useArenaTimer chain-driven mode (#1552)', () => {
  const NOW = 1_700_000_000;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW * 1000);
    mockIsVisible = true;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports commit before the commit deadline', () => {
    const { result } = renderHook(() =>
      useArenaTimer({
        initialSeconds: 0,
        commitDeadline: NOW + 60,
        revealDeadline: NOW + 120,
      })
    );
    expect(result.current.phase).toBe('commit');
    expect(result.current.rawSeconds).toBe(60);
    expect(result.current.activeDeadline).toBe(NOW + 60);
  });

  it('reports reveal between the commit and reveal deadlines', () => {
    const { result } = renderHook(() =>
      useArenaTimer({
        initialSeconds: 0,
        commitDeadline: NOW - 60,
        revealDeadline: NOW + 60,
      })
    );
    expect(result.current.phase).toBe('reveal');
    expect(result.current.rawSeconds).toBe(60);
    expect(result.current.activeDeadline).toBe(NOW + 60);
  });

  it('reports expired at or after the reveal deadline', () => {
    const { result } = renderHook(() =>
      useArenaTimer({
        initialSeconds: 0,
        commitDeadline: NOW - 120,
        revealDeadline: NOW,
      })
    );
    expect(result.current.phase).toBe('expired');
    expect(result.current.rawSeconds).toBe(0);
  });

  it('treats a zero reveal deadline as an unbounded reveal window', () => {
    const { result } = renderHook(() =>
      useArenaTimer({
        initialSeconds: 0,
        commitDeadline: NOW - 1,
        revealDeadline: 0,
      })
    );
    expect(result.current.phase).toBe('reveal');
    expect(result.current.activeDeadline).toBeNull();
    expect(result.current.formattedTime).toBe('--:--');
  });

  it('advances the phase with the wall clock, not a local counter', () => {
    const { result } = renderHook(() =>
      useArenaTimer({
        initialSeconds: 0,
        commitDeadline: NOW + 2,
        revealDeadline: NOW + 10,
      })
    );
    expect(result.current.phase).toBe('commit');
    act(() => { jest.advanceTimersByTime(2000); });
    expect(result.current.phase).toBe('reveal');
    act(() => { jest.advanceTimersByTime(8000); });
    expect(result.current.phase).toBe('expired');
  });

  it('calls onTimeUp once when the round deadline is reached', () => {
    const onTimeUp = jest.fn();
    renderHook(() =>
      useArenaTimer({
        initialSeconds: 0,
        commitDeadline: NOW + 5,
        revealDeadline: NOW + 10,
        onTimeUp,
      })
    );
    act(() => { jest.advanceTimersByTime(10500); });
    expect(onTimeUp).toHaveBeenCalledTimes(1);
    act(() => { jest.advanceTimersByTime(2000); });
    expect(onTimeUp).toHaveBeenCalledTimes(1);
  });
});
