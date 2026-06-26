import { PrismaClient } from "@prisma/client";
import { ArenaStatsService } from "../src/services/arenaStatsService";

const prisma = new PrismaClient();
const service = new ArenaStatsService(prisma);

// Helpers ──────────────────────────────────────────────────────────────────

async function createArena(minStake = 50) {
  return prisma.arena.create({ data: { metadata: { minStake } } });
}

async function createUser(walletSuffix: string) {
  return prisma.user.create({
    data: { walletAddress: `GTEST${walletSuffix.padEnd(51, "A")}` },
  });
}

async function cleanup(arenaId: string) {
  await prisma.eliminationLog.deleteMany({
    where: { round: { arenaId } },
  });
  await prisma.round.deleteMany({ where: { arenaId } });
  await prisma.pool.deleteMany({ where: { arenaId } });
  await prisma.arena.delete({ where: { id: arenaId } }).catch(() => {});
}

async function cleanupUsers(userIds: string[]) {
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe("ArenaStatsService.getArenaStats", () => {
  it("returns zero counts for an arena with no rounds", async () => {
    if (!process.env.DATABASE_URL) return;

    const arena = await createArena(50);

    try {
      const stats = await service.getArenaStats(arena.id);

      expect(stats.arenaId).toBe(arena.id);
      expect(stats.currentRound).toBe(0);
      expect(stats.playerCount).toBe(0);
      expect(stats.survivorCount).toBeGreaterThanOrEqual(0);
      expect(stats.yieldAccrued).toBe(0);
      expect(stats.currentPot).toBe(0);
      expect(stats.entryFee).toBe(50);
      // No rounds means no state — service falls back to "pending"
      expect(stats.status).toBe("pending");
    } finally {
      await cleanup(arena.id);
    }
  });

  it("counts players from Pool entries for a pre-start arena (0 rounds)", async () => {
    if (!process.env.DATABASE_URL) return;

    const arena = await createArena(50);

    // 3 players joined (Pool entries) but no round has started yet
    await prisma.pool.createMany({
      data: [
        { arenaId: arena.id, stakeAmount: 50 },
        { arenaId: arena.id, stakeAmount: 50 },
        { arenaId: arena.id, stakeAmount: 50 },
      ],
    });

    try {
      const stats = await service.getArenaStats(arena.id);

      expect(stats.playerCount).toBe(3);
      expect(stats.currentRound).toBe(0);
      expect(stats.status).toBe("pending");
    } finally {
      await cleanup(arena.id);
    }
  });

  it("counts players who joined but did not submit a choice in round 1", async () => {
    if (!process.env.DATABASE_URL) return;

    const arena = await createArena(50);
    const users = await Promise.all([createUser("NP1"), createUser("NP2")]);

    // 4 players joined via Pool, but only 2 appear in round 1 metadata choices
    await prisma.pool.createMany({
      data: Array(4).fill({ arenaId: arena.id, stakeAmount: 50 }),
    });

    await prisma.round.create({
      data: {
        arenaId: arena.id,
        roundNumber: 1,
        state: "OPEN",
        metadata: {
          playerChoices: [
            { userId: users[0].id, stake: 50 },
            { userId: users[1].id, stake: 50 },
          ],
        },
      },
    });

    try {
      const stats = await service.getArenaStats(arena.id);

      // Pool count reflects all 4 joined players, not just the 2 with choices
      expect(stats.playerCount).toBe(4);
    } finally {
      await cleanup(arena.id);
      await cleanupUsers(users.map((u) => u.id));
    }
  });

  it("counts players and survivors correctly after the first round with eliminations", async () => {
    if (!process.env.DATABASE_URL) return;

    const arena = await createArena(50);
    const users = await Promise.all([
      createUser("U1"),
      createUser("U2"),
      createUser("U3"),
      createUser("U4"),
      createUser("U5"),
    ]);

    // Each user has a Pool entry representing their joined stake
    await prisma.pool.createMany({
      data: users.map(() => ({ arenaId: arena.id, stakeAmount: 50 })),
    });

    const round = await prisma.round.create({
      data: {
        arenaId: arena.id,
        roundNumber: 1,
        state: "RESOLVED",
        metadata: {
          playerChoices: users.map((u) => ({ userId: u.id, stake: 50 })),
          oracleYield: 5,
        },
      },
    });

    // Eliminate 3 of the 5 players.
    await prisma.eliminationLog.createMany({
      data: [
        { roundId: round.id, userId: users[2].id, reason: "wrong choice" },
        { roundId: round.id, userId: users[3].id, reason: "wrong choice" },
        { roundId: round.id, userId: users[4].id, reason: "wrong choice" },
      ],
    });

    try {
      const stats = await service.getArenaStats(arena.id);

      expect(stats.playerCount).toBe(5);
      expect(stats.survivorCount).toBe(2);
      expect(stats.currentRound).toBe(1);
      expect(stats.status).toBe("resolved");
    } finally {
      await cleanup(arena.id);
      await cleanupUsers(users.map((u) => u.id));
    }
  });

  it("accumulates yield across multiple resolved rounds", async () => {
    if (!process.env.DATABASE_URL) return;

    const arena = await createArena(100);
    const users = await Promise.all([
      createUser("Y1"),
      createUser("Y2"),
    ]);

    await prisma.pool.createMany({
      data: users.map(() => ({ arenaId: arena.id, stakeAmount: 100 })),
    });

    for (let i = 1; i <= 3; i++) {
      await prisma.round.create({
        data: {
          arenaId: arena.id,
          roundNumber: i,
          state: "RESOLVED",
          metadata: {
            playerChoices: users.map((u) => ({ userId: u.id, stake: 100 })),
            oracleYield: 10,
          },
        },
      });
    }

    try {
      const stats = await service.getArenaStats(arena.id);

      expect(stats.yieldAccrued).toBeCloseTo(30);
      expect(stats.currentRound).toBe(3);
    } finally {
      await cleanup(arena.id);
      await cleanupUsers(users.map((u) => u.id));
    }
  });

  it("does not count yield from rounds that are not yet RESOLVED", async () => {
    if (!process.env.DATABASE_URL) return;

    const arena = await createArena(100);
    const user = await createUser("NR1");

    await prisma.pool.create({ data: { arenaId: arena.id, stakeAmount: 100 } });

    // One resolved round with yield, one open round without.
    await prisma.round.create({
      data: {
        arenaId: arena.id,
        roundNumber: 1,
        state: "RESOLVED",
        metadata: {
          playerChoices: [{ userId: user.id, stake: 100 }],
          oracleYield: 20,
        },
      },
    });
    await prisma.round.create({
      data: {
        arenaId: arena.id,
        roundNumber: 2,
        state: "OPEN",
        metadata: {
          playerChoices: [{ userId: user.id, stake: 100 }],
          oracleYield: 999,
        },
      },
    });

    try {
      const stats = await service.getArenaStats(arena.id);

      expect(stats.yieldAccrued).toBeCloseTo(20);
    } finally {
      await cleanup(arena.id);
      await cleanupUsers([user.id]);
    }
  });

  it("throws a not-found error for an unknown arena ID", async () => {
    await expect(
      service.getArenaStats("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(/not found/i);
  });
});
