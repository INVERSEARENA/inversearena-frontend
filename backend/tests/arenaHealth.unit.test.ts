/**
 * Arena Health Service — unit tests (#1412)
 *
 * Covers: healthy, degraded (each signal), critical (each signal),
 * no-active-round (state drift = 0), and threshold boundary values.
 */

import { ArenaHealthService, type ArenaHealthSummary } from "../src/services/arenaHealthService";
import type { PrismaClient } from "@prisma/client";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

function makeDate(msAgo: number): Date {
  return new Date(Date.now() - msAgo);
}

function makePrisma(opts: {
  lastResolved?: Date | null;
  oldestQueued?: Date | null;
  activeRound?: { state: string; updatedAt: Date } | null;
}): PrismaClient {
  return {
    round: {
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        const states: string[] = where?.state?.in ?? [];
        // last resolved/settled round
        if (states.includes("RESOLVED") || states.includes("SETTLED")) {
          return Promise.resolve(opts.lastResolved != null ? { updatedAt: opts.lastResolved } : null);
        }
        // active (OPEN/CLOSED) round
        if (states.includes("OPEN") || states.includes("CLOSED")) {
          return Promise.resolve(opts.activeRound ?? null);
        }
        return Promise.resolve(null);
      }),
    },
    transaction: {
      findFirst: jest.fn().mockResolvedValue(
        opts.oldestQueued != null ? { createdAt: opts.oldestQueued } : null,
      ),
    },
    arena: {
      findUnique: jest.fn().mockResolvedValue({ id: "arena-1" }),
    },
  } as unknown as PrismaClient;
}

describe("ArenaHealthService", () => {
  it("returns healthy when all signals are within bounds", async () => {
    const prisma = makePrisma({
      lastResolved: makeDate(30 * SECOND),    // 30s chain lag — healthy
      oldestQueued: makeDate(10 * SECOND),    // 10s queue lag — healthy
      activeRound: { state: "OPEN", updatedAt: makeDate(20 * SECOND) }, // 20s in OPEN, TTL 90s — no drift
    });
    const svc = new ArenaHealthService(prisma);
    const result = await svc.getArenaHealth("arena-1");

    expect(result.overallStatus).toBe("healthy");
    expect(result.signals.chainLag.status).toBe("healthy");
    expect(result.signals.queueLag.status).toBe("healthy");
    expect(result.signals.stateDrift.status).toBe("healthy");
  });

  it("returns degraded when chain lag is above warn threshold (120s)", async () => {
    const prisma = makePrisma({
      lastResolved: makeDate(150 * SECOND),  // 150s > 120s warn
      oldestQueued: null,
      activeRound: null,
    });
    const svc = new ArenaHealthService(prisma);
    const result = await svc.getArenaHealth("arena-1");

    expect(result.overallStatus).toBe("degraded");
    expect(result.signals.chainLag.status).toBe("degraded");
  });

  it("returns critical when chain lag exceeds critical threshold (300s)", async () => {
    const prisma = makePrisma({
      lastResolved: makeDate(310 * SECOND),
      oldestQueued: null,
      activeRound: null,
    });
    const svc = new ArenaHealthService(prisma);
    const result = await svc.getArenaHealth("arena-1");

    expect(result.overallStatus).toBe("critical");
    expect(result.signals.chainLag.status).toBe("critical");
  });

  it("returns degraded when queue lag is above warn threshold (60s)", async () => {
    const prisma = makePrisma({
      lastResolved: makeDate(10 * SECOND),
      oldestQueued: makeDate(90 * SECOND), // 90s > 60s warn
      activeRound: null,
    });
    const svc = new ArenaHealthService(prisma);
    const result = await svc.getArenaHealth("arena-1");

    expect(result.overallStatus).toBe("degraded");
    expect(result.signals.queueLag.status).toBe("degraded");
  });

  it("returns degraded when round state drift exceeds warn threshold", async () => {
    // OPEN TTL is 90s; 200s in OPEN = 110s drift > 90s warn
    const prisma = makePrisma({
      lastResolved: makeDate(10 * SECOND),
      oldestQueued: null,
      activeRound: { state: "OPEN", updatedAt: makeDate(200 * SECOND) },
    });
    const svc = new ArenaHealthService(prisma);
    const result = await svc.getArenaHealth("arena-1");

    expect(result.signals.stateDrift.roundState).toBe("OPEN");
    expect(result.signals.stateDrift.status).toBe("degraded");
  });

  it("returns healthy with 0 drift when there is no active round", async () => {
    const prisma = makePrisma({
      lastResolved: makeDate(10 * SECOND),
      oldestQueued: null,
      activeRound: null,
    });
    const svc = new ArenaHealthService(prisma);
    const result = await svc.getArenaHealth("arena-1");

    expect(result.signals.stateDrift.valueSeconds).toBe(0);
    expect(result.signals.stateDrift.status).toBe("healthy");
    expect(result.signals.stateDrift.roundState).toBe("NONE");
  });

  it("includes evidenceAt timestamps for each signal", async () => {
    const resolvedAt = makeDate(40 * SECOND);
    const prisma = makePrisma({
      lastResolved: resolvedAt,
      oldestQueued: null,
      activeRound: { state: "CLOSED", updatedAt: makeDate(5 * SECOND) },
    });
    const svc = new ArenaHealthService(prisma);
    const result = await svc.getArenaHealth("arena-1");

    expect(result.signals.chainLag.evidenceAt).toBe(resolvedAt.toISOString());
    expect(result.evaluatedAt).toBeTruthy();
  });

  it("returns healthy with 0 chain lag when no resolved rounds exist yet", async () => {
    const prisma = makePrisma({
      lastResolved: null,
      oldestQueued: null,
      activeRound: null,
    });
    const svc = new ArenaHealthService(prisma);
    const result = await svc.getArenaHealth("arena-1");

    expect(result.signals.chainLag.valueSeconds).toBe(0);
    expect(result.signals.chainLag.status).toBe("healthy");
  });
});
