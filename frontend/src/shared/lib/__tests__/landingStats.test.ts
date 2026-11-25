/**
 * @jest-environment node
 */
import {
  fetchLandingStats,
  EMPTY_LANDING_STATS,
  LANDING_REVALIDATE_SECONDS,
  LANDING_STATS_TAG,
} from "../landingStats";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("fetchLandingStats (#1626)", () => {
  it("revalidates at or below 60 seconds", () => {
    expect(LANDING_REVALIDATE_SECONDS).toBeLessThanOrEqual(60);
  });

  it("fetches /api/stats/landing with the ISR tag and revalidate window", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ totalArenas: 7, activeArenas: 2 }));

    await fetchLandingStats(fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { next?: { revalidate: number; tags: string[] } }];
    expect(url).toContain("/api/stats/landing");
    expect(init.next?.revalidate).toBe(LANDING_REVALIDATE_SECONDS);
    expect(init.next?.tags).toContain(LANDING_STATS_TAG);
  });

  it("returns the parsed payload", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        totalArenas: 7,
        activeArenas: 2,
        totalPlayers: 50,
        totalYieldAccrued: 12.5,
        generatedAt: "2026-05-01T00:00:00.000Z",
      }),
    );

    const stats = await fetchLandingStats(fetchImpl as unknown as typeof fetch);

    expect(stats).toEqual({
      totalArenas: 7,
      activeArenas: 2,
      totalPlayers: 50,
      totalYieldAccrued: 12.5,
      generatedAt: "2026-05-01T00:00:00.000Z",
    });
  });

  it("falls back to empty stats when the backend errors", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("network down");
    });

    const stats = await fetchLandingStats(fetchImpl as unknown as typeof fetch);

    expect(stats).toEqual(EMPTY_LANDING_STATS);
  });

  it("falls back to empty stats on a non-2xx response", async () => {
    const fetchImpl = jest.fn(async () => new Response("nope", { status: 500 }));

    const stats = await fetchLandingStats(fetchImpl as unknown as typeof fetch);

    expect(stats).toEqual(EMPTY_LANDING_STATS);
  });
});
