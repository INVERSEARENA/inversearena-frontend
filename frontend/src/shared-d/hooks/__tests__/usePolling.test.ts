import { renderHook, waitFor, act } from '@testing-library/react';
import { usePolling } from '../usePolling';

let mockIsVisible = true;
jest.mock('../usePageVisibility', () => ({
  usePageVisibility: () => mockIsVisible,
}));

describe('usePolling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockIsVisible = true;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('starts in idle state with no initialData', () => {
    const fetcher = jest.fn().mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() =>
      usePolling(fetcher, { intervalMs: 1000, enabled: false })
    );
    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('starts in success state when initialData is provided', () => {
    const fetcher = jest.fn().mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() =>
      usePolling(fetcher, { intervalMs: 1000, enabled: false, initialData: 42 })
    );
    expect(result.current.status).toBe('success');
    expect(result.current.data).toBe(42);
  });

  it('fetches on mount and transitions to success', async () => {
    const fetcher = jest.fn().mockResolvedValue('hello');
    const { result } = renderHook(() =>
      usePolling(fetcher, { intervalMs: 5000, enabled: true })
    );

    expect(result.current.status).toBe('loading');

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.data).toBe('hello');
    expect(result.current.error).toBeNull();
  });

  it('transitions to error state on fetch failure', async () => {
    const fetcher = jest.fn().mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() =>
      usePolling(fetcher, { intervalMs: 5000, enabled: true })
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.message).toBe('network error');
  });

  it('does not fetch when enabled is false', () => {
    const fetcher = jest.fn().mockResolvedValue('data');
    renderHook(() =>
      usePolling(fetcher, { intervalMs: 1000, enabled: false })
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('polls on interval when tab is visible', async () => {
    const fetcher = jest.fn().mockResolvedValue('data');
    renderHook(() =>
      usePolling(fetcher, { intervalMs: 1000, enabled: true })
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    act(() => { jest.advanceTimersByTime(3000); });

    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('stops polling when tab is hidden', async () => {
    const fetcher = jest.fn().mockResolvedValue('data');
    const { rerender } = renderHook(() =>
      usePolling(fetcher, { intervalMs: 1000, enabled: true })
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    mockIsVisible = false;
    rerender();

    const callCount = fetcher.mock.calls.length;
    act(() => { jest.advanceTimersByTime(3000); });
    expect(fetcher.mock.calls.length).toBe(callCount);
  });

  it('refresh triggers an immediate refetch', async () => {
    const fetcher = jest.fn().mockResolvedValue('data');
    const { result } = renderHook(() =>
      usePolling(fetcher, { intervalMs: 5000, enabled: true })
    );

    await waitFor(() => expect(result.current.status).toBe('success'));
    const prevCount = fetcher.mock.calls.length;

    act(() => { result.current.refresh(); });

    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(prevCount));
  });
});
