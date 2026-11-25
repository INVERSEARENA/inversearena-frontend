import { renderHook, act } from '@testing-library/react';
import { useArenaTimer } from '../useArenaTimer';

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
