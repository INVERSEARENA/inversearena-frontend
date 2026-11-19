import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useQuickPlay } from "./QuickPlay";

const mockFetch = vi.fn();
global.fetch = mockFetch;

const WALLET = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

const MOCK_MATCH = {
  arenaId: "arena-1",
  arenaName: "XLM Blitz",
  currency: "XLM",
  entryFee: 100,
  currentPlayers: 3,
  maxPlayers: 8,
  estimatedStartSecs: 300,
};

describe("useQuickPlay", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("starts in idle status", () => {
    const { result } = renderHook(() => useQuickPlay(WALLET));
    expect(result.current.status).toBe("idle");
  });

  it("transitions to found when API returns a match", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(MOCK_MATCH),
    });
    const { result } = renderHook(() => useQuickPlay(WALLET));
    await act(async () => { await result.current.findArena(); });
    expect(result.current.status).toBe("found");
    expect(result.current.match?.arenaId).toBe("arena-1");
  });

  it("transitions to none when API returns 404", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const { result } = renderHook(() => useQuickPlay(WALLET));
    await act(async () => { await result.current.findArena(); });
    expect(result.current.status).toBe("none");
    expect(result.current.match).toBeNull();
  });

  it("sets error when no wallet connected", async () => {
    const { result } = renderHook(() => useQuickPlay(undefined));
    await act(async () => { await result.current.findArena(); });
    expect(result.current.error).toBeTruthy();
    expect(result.current.status).toBe("idle");
  });

  it("includes asset and maxStake in the query string", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(MOCK_MATCH) });
    const { result } = renderHook(() => useQuickPlay(WALLET));
    act(() => { result.current.updatePrefs({ asset: "USDC", maxStake: 500 }); });
    await act(async () => { await result.current.findArena(); });
    const url: string = mockFetch.mock.calls[0][0];
    expect(url).toContain("asset=USDC");
    expect(url).toContain("maxStake=500");
  });

  it("reset returns to idle", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(MOCK_MATCH) });
    const { result } = renderHook(() => useQuickPlay(WALLET));
    await act(async () => { await result.current.findArena(); });
    act(() => { result.current.reset(); });
    expect(result.current.status).toBe("idle");
    expect(result.current.match).toBeNull();
  });
});
