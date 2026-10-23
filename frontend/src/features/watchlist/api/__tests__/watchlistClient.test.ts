import { fetchWatchlist, watchArena, unwatchArena, WatchlistRequestError } from "../watchlistClient";

function mockFetch(response: Partial<Response> & { json: () => Promise<unknown> }): typeof fetch {
  return jest.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

describe("watchlistClient", () => {
  it("fetchWatchlist returns the watched arena ids", async () => {
    const fetchImpl = mockFetch({ ok: true, status: 200, json: async () => ({ watchedArenaIds: ["a", "b"] }) });

    const result = await fetchWatchlist("token", fetchImpl);
    expect(result).toEqual(["a", "b"]);
  });

  it("watchArena sends a PUT request and returns the updated list", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ watchedArenaIds: ["arena-1"] }),
    }) as unknown as typeof fetch;

    const result = await watchArena("arena-1", "token", fetchImpl);

    expect(result).toEqual(["arena-1"]);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/api/users/me/watchlist/arena-1"),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("unwatchArena sends a DELETE request and returns the updated list", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ watchedArenaIds: [] }),
    }) as unknown as typeof fetch;

    const result = await unwatchArena("arena-1", "token", fetchImpl);

    expect(result).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/api/users/me/watchlist/arena-1"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("encodes the arena id in the URL", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ watchedArenaIds: [] }),
    }) as unknown as typeof fetch;

    await watchArena("arena/weird id", "token", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent("arena/weird id")),
      expect.anything(),
    );
  });

  it("throws WatchlistRequestError for a non-OK response", async () => {
    const fetchImpl = mockFetch({ ok: false, status: 404, json: async () => ({}) });
    await expect(fetchWatchlist("token", fetchImpl)).rejects.toThrow(WatchlistRequestError);
  });

  it("throws WatchlistRequestError when the network request fails", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    await expect(fetchWatchlist("token", fetchImpl)).rejects.toThrow(WatchlistRequestError);
  });

  it("includes the bearer token in the Authorization header", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ watchedArenaIds: [] }),
    }) as unknown as typeof fetch;

    await fetchWatchlist("my-token", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ headers: { Authorization: "Bearer my-token" } }),
    );
  });
});
