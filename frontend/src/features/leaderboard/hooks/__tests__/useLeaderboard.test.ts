import { renderHook, act, waitFor } from "@testing-library/react";
import { useLeaderboard } from "../useLeaderboard";

const mockFetch = jest.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: jest.fn(() => null),
      setItem: jest.fn(),
      removeItem: jest.fn(),
      clear: jest.fn(),
    },
    writable: true,
  });
});

function makePlayers(count: number, startRank = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    rank: startRank + i,
    walletAddress: `addr${i}`,
    survivalStreak: i + 1,
    totalYield: (i + 1) * 100,
    arenasWon: i,
  }));
}

function mockSuccess(players: ReturnType<typeof makePlayers>, nextCursor: string | null = null) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ players, nextCursor }),
  });
}

function mockFailure(status: number) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({}),
  });
}

function mockNetworkError() {
  mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
}

describe("useLeaderboard", () => {
  it("starts with loading=true and empty survivors", () => {
    mockSuccess([]);
    const { result } = renderHook(() => useLeaderboard());

    expect(result.current.loading).toBe(true);
    expect(result.current.survivors).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("loads survivors on mount", async () => {
    const players = makePlayers(3);
    mockSuccess(players);

    const { result } = renderHook(() => useLeaderboard());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.survivors).toHaveLength(3);
    expect(result.current.survivors[0]!.agentId).toBe("addr0");
    expect(result.current.survivors[0]!.rank).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it("sets hasMore and nextCursor when API returns a cursor", async () => {
    const players = makePlayers(20);
    mockSuccess(players, "cursor-abc");

    const { result } = renderHook(() => useLeaderboard());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasMore).toBe(true);
    expect(result.current.nextCursor).toBe("cursor-abc");
  });

  it("sets hasMore=false when API returns no cursor", async () => {
    mockSuccess(makePlayers(5));

    const { result } = renderHook(() => useLeaderboard());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.hasMore).toBe(false);
    expect(result.current.nextCursor).toBeNull();
  });

  it("sets error on HTTP failure", async () => {
    mockFailure(500);

    const { result } = renderHook(() => useLeaderboard());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("Leaderboard request failed: 500");
    expect(result.current.survivors).toEqual([]);
  });

  it("sets error on network failure", async () => {
    mockNetworkError();

    const { result } = renderHook(() => useLeaderboard());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("Failed to fetch");
    expect(result.current.survivors).toEqual([]);
  });

  it("fetchMore appends new survivors", async () => {
    const page1 = makePlayers(2, 1);
    const page2 = makePlayers(2, 3);

    mockSuccess(page1, "cursor-p2");

    const { result } = renderHook(() => useLeaderboard());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.survivors).toHaveLength(2);

    mockSuccess(page2, null);

    await act(async () => {
      await result.current.fetchMore();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.survivors).toHaveLength(4);
    expect(result.current.survivors[2]!.rank).toBe(3);
    expect(result.current.hasMore).toBe(false);
  });

  it("fetchMore does nothing when no nextCursor", async () => {
    mockSuccess(makePlayers(2));

    const { result } = renderHook(() => useLeaderboard());

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.fetchMore();
    });

    expect(result.current.survivors).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("refetch replaces survivors instead of appending", async () => {
    const page1 = makePlayers(2, 1);
    mockSuccess(page1, "cursor-x");

    const { result } = renderHook(() => useLeaderboard());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.survivors).toHaveLength(2);

    const fresh = makePlayers(3, 10);
    mockSuccess(fresh);

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.survivors).toHaveLength(3);
    expect(result.current.survivors[0]!.rank).toBe(10);
  });

  it("includes Authorization header when accessToken exists", async () => {
    (window.localStorage.getItem as jest.Mock).mockReturnValue("test-token-123");
    mockSuccess([]);

    renderHook(() => useLeaderboard());

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer test-token-123");
  });

  it("does not include Authorization header when no token", async () => {
    mockSuccess([]);

    renderHook(() => useLeaderboard());

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("sends correct limit parameter", async () => {
    mockSuccess([]);

    renderHook(() => useLeaderboard(10));

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("limit=10");
  });

  it("sends cursor parameter on fetchMore", async () => {
    mockSuccess(makePlayers(5), "next-cursor-xyz");

    const { result } = renderHook(() => useLeaderboard());

    await waitFor(() => expect(result.current.loading).toBe(false));

    mockSuccess([]);

    await act(async () => {
      await result.current.fetchMore();
    });

    const url = mockFetch.mock.calls[1][0] as string;
    expect(url).toContain("cursor=next-cursor-xyz");
  });

  it("clears error on successful refetch after failure", async () => {
    mockFailure(500);

    const { result } = renderHook(() => useLeaderboard());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeTruthy();

    mockSuccess(makePlayers(1));

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.survivors).toHaveLength(1);
  });
});
