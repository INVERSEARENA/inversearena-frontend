/**
 * Coverage for ProfileApiRepository.getHistory (#1403): wires the
 * previously-placeholder profile history view to the real cursor-paginated
 * GET /api/users/me/activity endpoint, mapping elimination events to
 * HistoryEntry and falling back to mock data only on a genuine failure.
 */
import { profileRepository } from "../profileRepository";

function mockFetchOnce(ok: boolean, body: unknown, status = 200) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok,
    status,
    json: async () => body,
  });
}

describe("profileRepository.getHistory", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    window.localStorage.clear();
  });

  it("maps activity feed items to HistoryEntry objects", async () => {
    mockFetchOnce(true, {
      walletAddress: "GWALLET",
      items: [
        {
          id: "elim-1",
          type: "player_eliminated",
          timestamp: "2026-01-01T00:00:00.000Z",
          arenaId: "arena-1",
          roundNumber: 3,
          reason: "ELIMINATED_BY_ROUND",
        },
      ],
      cursor: null,
      hasMore: false,
    });

    const history = await profileRepository.getHistory("GWALLET");

    expect(history).toEqual([
      {
        id: "elim-1",
        action: "arena_eliminated",
        description: "Eliminated in round 3 (ELIMINATED_BY_ROUND)",
        timestamp: new Date("2026-01-01T00:00:00.000Z"),
        arenaId: "arena-1",
      },
    ]);
  });

  it("omits the parenthetical when reason is null", async () => {
    mockFetchOnce(true, {
      walletAddress: "GWALLET",
      items: [
        {
          id: "elim-1",
          type: "player_eliminated",
          timestamp: "2026-01-01T00:00:00.000Z",
          arenaId: "arena-1",
          roundNumber: 3,
          reason: null,
        },
      ],
      cursor: null,
      hasMore: false,
    });

    const history = await profileRepository.getHistory("GWALLET");

    expect(history[0]?.description).toBe("Eliminated in round 3");
  });

  it("sends the stored access token as a Bearer header when present", async () => {
    window.localStorage.setItem("access_token", "test-token");
    mockFetchOnce(true, { items: [], cursor: null, hasMore: false });

    await profileRepository.getHistory("GWALLET");

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/users/me/activity"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      }),
    );
  });

  it("returns an empty array when the feed has no events, without falling back to mock", async () => {
    mockFetchOnce(true, { items: [], cursor: null, hasMore: false });

    const history = await profileRepository.getHistory("GWALLET");

    expect(history).toEqual([]);
  });

  it("falls back to mock history when the request fails", async () => {
    mockFetchOnce(false, {}, 500);

    const history = await profileRepository.getHistory("GWALLET");

    // Falling back means it does NOT throw, and returns *some* array
    // (the mock repository's own fixture data), not an empty/broken result.
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBeGreaterThan(0);
  });

  it("falls back to mock history when fetch itself rejects (network error)", async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("network down"));

    const history = await profileRepository.getHistory("GWALLET");

    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBeGreaterThan(0);
  });
});
