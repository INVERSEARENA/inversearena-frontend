/**
 * Server-side fetch for the public landing statistics feed (#1626).
 *
 * The landing page renders These aggregates with ISR: the fetch is tagged so
 * an on-chain configuration change (which fires the backend -> frontend
 * revalidation webhook) can drop it with `revalidateTag("landing-stats")`
 * instead of waiting out the full revalidate window.
 *
 * Only usable from a Server Component / route handler: it reads the backend
 * origin on the server. It never runs in the browser bundle.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

/** Cache tag applied to the landing stats fetch. */
export const LANDING_STATS_TAG = "landing-stats";

/** ISR revalidate window in seconds (issue #1626: must be <= 60). */
export const LANDING_REVALIDATE_SECONDS = 60;

export interface LandingStats {
  totalArenas: number;
  activeArenas: number;
  totalPlayers: number;
  totalYieldAccrued: number;
  generatedAt: string;
}

export const EMPTY_LANDING_STATS: LandingStats = {
  totalArenas: 0,
  activeArenas: 0,
  totalPlayers: 0,
  totalYieldAccrued: 0,
  generatedAt: new Date(0).toISOString(),
};

/**
 * Fetches the landing stats with ISR caching. A backend outage must not break
 * the marketing page, so a failed fetch resolves to empty stats rather than
 * throwing; the next revalidation retries.
 */
export async function fetchLandingStats(
  fetchImpl: typeof fetch = fetch,
): Promise<LandingStats> {
  try {
    const response = await fetchImpl(`${API_BASE}/api/stats/landing`, {
      next: { revalidate: LANDING_REVALIDATE_SECONDS, tags: [LANDING_STATS_TAG] },
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return EMPTY_LANDING_STATS;
    }
    const parsed = (await response.json()) as Partial<LandingStats>;
    return {
      totalArenas: parsed.totalArenas ?? 0,
      activeArenas: parsed.activeArenas ?? 0,
      totalPlayers: parsed.totalPlayers ?? 0,
      totalYieldAccrued: parsed.totalYieldAccrued ?? 0,
      generatedAt: parsed.generatedAt ?? EMPTY_LANDING_STATS.generatedAt,
    };
  } catch {
    return EMPTY_LANDING_STATS;
  }
}
