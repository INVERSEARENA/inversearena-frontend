import type { PrismaClient } from "@prisma/client";

/**
 * Aggregate landing statistics (#1626).
 *
 * A single public, anonymous feed for the marketing landing page. It is
 * deliberately small and composed only of aggregates so it is identical for
 * every caller and safe to serve from the CDN edge.
 *
 * Data sources (all aggregates, no per-user rows):
 *  - `totalArenas`   : count of Arena rows
 *  - `activeArenas`  : Arena rows whose metadata.status is "ACTIVE"
 *  - `totalPlayers`  : distinct participant count, from the precomputed
 *                      ArenaStats rollup (falls back to 0 when absent)
 *  - `totalYieldAccrued` : sum of ArenaStats.yieldAccrued
 *
 * The numbers are approximate (they are rounded for display and refreshed on
 * a timer), which is exactly why they can be edge-cached: nothing here is
 * financially actionable and no caller-specific field is ever included.
 */

export interface LandingStats {
  totalArenas: number;
  activeArenas: number;
  totalPlayers: number;
  totalYieldAccrued: number;
  /** Ledger-agnostic revision the payload was generated at (epoch seconds). */
  generatedAt: string;
}

export interface LandingStatsOptions {
  /** Injectable clock for tests. */
  now?: () => Date;
}

export class LandingStatsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: LandingStatsOptions = {},
  ) {}

  async getLandingStats(): Promise<LandingStats> {
    const now = this.options.now ?? (() => new Date());

    const [totalArenas, activeArenas, statsAggregate] = await Promise.all([
      this.prisma.arena.count(),
      this.prisma.arena.count({
        where: { metadata: { path: ["status"], equals: "ACTIVE" } },
      }),
      this.prisma.arenaStats.aggregate({
        _sum: { players: true, yieldAccrued: true },
      }),
    ]);

    return {
      totalArenas,
      activeArenas,
      totalPlayers: statsAggregate._sum.players ?? 0,
      totalYieldAccrued: statsAggregate._sum.yieldAccrued ?? 0,
      generatedAt: now().toISOString(),
    };
  }
}

export function createLandingStatsService(
  prisma: PrismaClient,
  options?: LandingStatsOptions,
): LandingStatsService {
  return new LandingStatsService(prisma, options);
}
