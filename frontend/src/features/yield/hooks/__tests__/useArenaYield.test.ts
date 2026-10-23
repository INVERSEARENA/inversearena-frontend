import { renderHook, act, waitFor } from "@testing-library/react";
import { useArenaYield } from "../useArenaYield";

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

const series = {
  arenaId: "arena-1",
  asset: "USDC",
  assetDecimals: 6,
  points: [
    { round: 1, timestamp: "2026-01-01T00:00:00.000Z", rateBps: "500", accrued: "5.000000", cumulative: "5.000000" },
    { round: 2, timestamp: "2026-01-02T00:00:00.000Z", rateBps: "250", accrued: "2.500000", cumulative: "7.500000" },
  ],
  nextCursor: null,
  hasMore: false,
  finished: false,
};

describe("useArenaYield (#1568)", () => {
  it("does not fetch without an arena id", () => {
    const { result } = renderHook(() => useArenaYield(null));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.points).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it("loads the series for an arena id", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => series });
    const { result } = renderHook(() => useArenaYield("arena-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.current.points).toHaveLength(2);
    expect(result.current.points[1]!.cumulative).toBe("7.500000");
    expect(result.current.asset).toBe("USDC");
    expect(result.current.error).toBeNull();
  });

  it("requests the yield endpoint for the given arena", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => series });
    renderHook(() => useArenaYield("arena-9"));
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/api/arenas/arena-9/yield");
  });

  it("sets error on HTTP failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    const { result } = renderHook(() => useArenaYield("missing"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("Yield request failed: 404");
    expect(result.current.points).toEqual([]);
  });

  it("clears error on successful refetch after failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const { result } = renderHook(() => useArenaYield("arena-1"));
    await waitFor(() => expect(result.current.error).toBeTruthy());

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => series });
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.points).toHaveLength(2);
  });
});
