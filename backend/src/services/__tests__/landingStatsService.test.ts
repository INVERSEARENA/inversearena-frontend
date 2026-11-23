import type { PrismaClient } from "@prisma/client";

import { LandingStatsService } from "../landingStatsService";

function fakePrisma(overrides: {
  totalArenas?: number;
  activeArenas?: number;
  players?: number | null;
  yieldAccrued?: number | null;
}): PrismaClient {
  return {
    arena: {
      count: jest.fn(async (args?: { where?: unknown }) =>
        args?.where ? (overrides.activeArenas ?? 0) : (overrides.totalArenas ?? 0),
      ),
    },
    arenaStats: {
      aggregate: jest.fn(async () => ({
        _sum: {
          players: overrides.players ?? null,
          yieldAccrued: overrides.yieldAccrued ?? null,
        },
      })),
    },
  } as unknown as PrismaClient;
}

describe("LandingStatsService (#1626)", () => {
  it("returns aggregate counts and the yield sum", async () => {
    const service = new LandingStatsService(
      fakePrisma({ totalArenas: 12, activeArenas: 4, players: 350, yieldAccrued: 1234.5 }),
      { now: () => new Date("2026-05-01T00:00:00.000Z") },
    );

    const stats = await service.getLandingStats();

    expect(stats).toEqual({
      totalArenas: 12,
      activeArenas: 4,
      totalPlayers: 350,
      totalYieldAccrued: 1234.5,
      generatedAt: "2026-05-01T00:00:00.000Z",
    });
  });

  it("coalesces null aggregates to zero", async () => {
    const service = new LandingStatsService(
      fakePrisma({ totalArenas: 0, activeArenas: 0, players: null, yieldAccrued: null }),
    );

    const stats = await service.getLandingStats();

    expect(stats.totalPlayers).toBe(0);
    expect(stats.totalYieldAccrued).toBe(0);
  });

  it("filters active arenas by metadata.status", async () => {
    const prisma = fakePrisma({ totalArenas: 5, activeArenas: 2 });
    const service = new LandingStatsService(prisma);

    await service.getLandingStats();

    expect(prisma.arena.count).toHaveBeenCalledWith({
      where: { metadata: { path: ["status"], equals: "ACTIVE" } },
    });
  });
});
