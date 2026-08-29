/**
 * Regression for #1346: arenasWon / survivalStreak must use an anti-join
 * against RESOLVED-round eliminations, not subtraction of independently
 * scoped counts.
 */
import { PrismaClient } from "@prisma/client";
import { LeaderboardController } from "../src/controllers/leaderboard.controller";
import type { Request, Response } from "express";

const prisma = new PrismaClient();
const hasDb = () => Boolean(process.env.DATABASE_URL);

function makeReq(): Request {
  return { query: {} } as unknown as Request;
}

function makeRes(): { json: (body: unknown) => void; captured: unknown } {
  const res = {
    captured: undefined as unknown,
    json(body: unknown) {
      this.captured = body;
    },
  };
  return res;
}

describe("LeaderboardController — divergent elimination set (#1346)", () => {
  afterEach(async () => {
    if (!hasDb()) return;
    await prisma.eliminationLog.deleteMany();
    await prisma.round.deleteMany();
    await prisma.arena.deleteMany();
    await prisma.user.deleteMany();
  });

  it("credits arenasWon when an extra elimination is on a non-RESOLVED round", async () => {
    if (!hasDb()) return;

    const user = await prisma.user.create({ data: { walletAddress: "GLB1346WIN0001" } });
    const other = await prisma.user.create({ data: { walletAddress: "GLB1346WIN0002" } });

    const [arenaA, arenaB, arenaC, arenaD] = await Promise.all([
      prisma.arena.create({ data: {} }),
      prisma.arena.create({ data: {} }),
      prisma.arena.create({ data: {} }),
      prisma.arena.create({ data: {} }),
    ]);

    const resolved = (arenaId: string, eliminated: string, winner: string, amount: number) =>
      prisma.round.create({
        data: {
          arenaId,
          roundNumber: 1,
          state: "RESOLVED",
          metadata: {
            playerChoices: [
              { userId: user.id, choice: "HIGH", stake: 100 },
              { userId: other.id, choice: "LOW", stake: 100 },
            ],
            resolution: {
              eliminatedPlayers: [eliminated],
              payouts: [{ userId: winner, amount }],
            },
          },
        },
      });

    const rA = await resolved(arenaA.id, user.id, other.id, 150);
    const rB = await resolved(arenaB.id, user.id, other.id, 150);
    await resolved(arenaC.id, other.id, user.id, 200);
    const rD = await prisma.round.create({
      data: {
        arenaId: arenaD.id,
        roundNumber: 1,
        state: "OPEN",
        metadata: { playerChoices: [{ userId: user.id, choice: "HIGH", stake: 100 }] },
      },
    });

    await prisma.eliminationLog.createMany({
      data: [
        { roundId: rA.id, userId: user.id, reason: "ELIMINATED_BY_ROUND" },
        { roundId: rB.id, userId: user.id, reason: "ELIMINATED_BY_ROUND" },
        { roundId: rD.id, userId: user.id, reason: "ELIMINATED_BY_ROUND" },
      ],
    });

    const controller = new LeaderboardController(prisma);
    const res = makeRes();
    await controller.getLeaderboard(makeReq(), res as unknown as Response);

    const body = res.captured as {
      players: { id: string; arenasWon: number; survivalStreak: number; totalYield: number }[];
    };
    const row = body.players.find((p) => p.id === user.id);
    expect(row).toBeDefined();
    expect(row!.arenasWon).toBe(1);
    expect(row!.survivalStreak).toBe(1);
    expect(row!.totalYield).toBe(200);
  });
});
