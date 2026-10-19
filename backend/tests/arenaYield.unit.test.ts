import { test } from "node:test";
import assert from "node:assert";
import { ArenaYieldService } from "../src/services/arenaYieldService";

/**
 * Per-arena yield time-series (#1568).
 *
 * Points are sourced from indexed on-chain resolutions (round metadata):
 * ordered by round ascending, amounts as decimal strings in the arena stake
 * asset, zero-accrual rounds still emitted, cumulative correct across pages.
 */

function moneyYield(atomic: string) {
  return {
    userId: "user-1",
    amount: { atomicAmount: atomic, asset: { code: "USDC", decimals: 6 } },
    principal: { atomicAmount: "0", asset: { code: "USDC", decimals: 6 } },
    yieldAmount: { atomicAmount: atomic, asset: { code: "USDC", decimals: 6 } },
    platformFee: { atomicAmount: "0", asset: { code: "USDC", decimals: 6 } },
    dust: { atomicAmount: "0", asset: { code: "USDC", decimals: 6 } },
  };
}

function round(
  roundNumber: number,
  metadata: unknown,
  state = "RESOLVED",
  updatedAt = `2026-01-0${roundNumber}T00:00:00.000Z`,
) {
  return {
    roundNumber,
    state,
    metadata,
    updatedAt: new Date(updatedAt),
  };
}

function makeService(rounds: ReturnType<typeof round>[], stakeToken = "USDC") {
  const prisma = {
    arena: {
      findUnique: async () => ({ id: "arena-1", metadata: { stakeToken } }),
    },
    round: {
      findMany: async () => rounds,
    },
  } as any;
  return new ArenaYieldService(prisma);
}

test("builds an ordered series with decimal-string amounts and cumulative totals", async () => {
  const service = makeService([
    round(1, { oracleYield: 5, resolution: { payouts: [moneyYield("5000000")] } }),
    round(2, { oracleYield: 2.5, resolution: { payouts: [moneyYield("2500000")] } }),
  ]);

  const series = await service.getYieldSeries("arena-1");

  assert.equal(series.arenaId, "arena-1");
  assert.equal(series.asset, "USDC");
  assert.equal(series.assetDecimals, 6);
  assert.equal(series.points.length, 2);
  assert.deepEqual(series.points[0], {
    round: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    rateBps: "500",
    accrued: "5.000000",
    cumulative: "5.000000",
  });
  assert.deepEqual(series.points[1], {
    round: 2,
    timestamp: "2026-01-02T00:00:00.000Z",
    rateBps: "250",
    accrued: "2.500000",
    cumulative: "7.500000",
  });
  assert.equal(series.hasMore, false);
  assert.equal(series.nextCursor, null);
  assert.equal(series.finished, false);
});

test("emits zero-accrual rounds and null rates instead of gaps", async () => {
  const service = makeService([
    round(1, { resolution: { payouts: [] } }),
    round(2, { oracleYield: 0, resolution: { payouts: [] } }, "SETTLED"),
  ]);

  const series = await service.getYieldSeries("arena-1");

  assert.equal(series.points.length, 2);
  assert.equal(series.points[0]!.accrued, "0.000000");
  assert.equal(series.points[0]!.rateBps, null);
  assert.equal(series.points[1]!.cumulative, "0.000000");
  assert.equal(series.finished, true);
});

test("returns an empty series for arenas with zero resolved rounds", async () => {
  const service = makeService([]);
  const series = await service.getYieldSeries("arena-1");
  assert.deepEqual(series.points, []);
  assert.equal(series.hasMore, false);
  assert.equal(series.finished, false);
});

test("paginates while keeping cumulative correct across pages", async () => {
  const service = makeService([
    round(1, { oracleYield: 1, resolution: { payouts: [moneyYield("1000000")] } }),
    round(2, { oracleYield: 1, resolution: { payouts: [moneyYield("1000000")] } }),
    round(3, { oracleYield: 1, resolution: { payouts: [moneyYield("1000000")] } }),
  ]);

  const page1 = await service.getYieldSeries("arena-1", { limit: 2 });
  assert.equal(page1.points.length, 2);
  assert.equal(page1.hasMore, true);
  assert.ok(page1.nextCursor);

  const page2 = await service.getYieldSeries("arena-1", {
    limit: 2,
    cursor: page1.nextCursor!,
  });
  assert.equal(page2.points.length, 1);
  assert.equal(page2.points[0]!.round, 3);
  // Cumulative covers the full series, not just the page window.
  assert.equal(page2.points[0]!.cumulative, "3.000000");
  assert.equal(page2.hasMore, false);
});

test("throws not found for unknown arenas", async () => {
  const prisma = {
    arena: { findUnique: async () => null },
    round: { findMany: async () => [] },
  } as any;
  const service = new ArenaYieldService(prisma);
  await assert.rejects(() => service.getYieldSeries("missing"), /not found/);
});
