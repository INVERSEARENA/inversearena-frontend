/**
 * Regression coverage for #1217: UsersController's private aggregateStats
 * used to run four independent unbounded `prisma.round.findMany({ state:
 * "RESOLVED" })` scans (no arenaId/userId filter or limit), pulling every
 * resolved round's metadata into Node.js — four times per request. It now
 * uses a single indexed SQL query (mirroring the CTE pattern in
 * LeaderboardController) that aggregates per-user stats directly in
 * Postgres.
 *
 * These tests exercise the controller end-to-end against a real Postgres +
 * MongoDB (via the jest-wide mongodb-memory-server in test/setup.ts;
 * Postgres-backed assertions are skipped when DATABASE_URL is not
 * configured, matching the existing arenaStats.unit.test.ts convention) to
 * verify the SQL rewrite preserves the original per-field semantics exactly.
 *
 * Note: `req.user.id` is the authenticated user's MongoDB `_id` (see
 * AuthService.verifySignatureAndLogin / issueTokenPair, which sign the JWT
 * `sub` claim from `user._id.toString()`), and that same string is what
 * `aggregateStats` matches against `eliminationLog.userId` / round
 * metadata's `playerChoices[].userId` in Postgres — tables whose `userId`
 * is really a Prisma `users.id` UUID. Production never has a Prisma User
 * row whose id equals a Mongo ObjectId, so these two fields are only ever
 * accidentally reconciled (a separate, pre-existing correctness question
 * out of scope for this performance-focused issue). To exercise the SQL
 * aggregation itself, these fixtures force that reconciliation by creating
 * a Prisma User row whose id is set (via raw SQL) to the Mongo `_id`.
 */
import { PrismaClient } from "@prisma/client";
import type { Request, Response, NextFunction } from "express";
import { UsersController } from "../src/controllers/users.controller";
import { UserModel } from "../src/db/models/user.model";

const prisma = new PrismaClient();

function makeReq(userId: string): Request {
  return { user: { id: userId, walletAddress: "wallet" } } as unknown as Request;
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

async function cleanDb() {
  await prisma.eliminationLog.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.round.deleteMany();
  await prisma.pool.deleteMany();
  await prisma.arena.deleteMany();
  await prisma.user.deleteMany();
  await UserModel.deleteMany({});
}

/**
 * Creates the Mongo identity and a Prisma `users` row sharing the same id
 * (via raw SQL, since Prisma's `id` is normally server-generated), so the
 * fixture can exercise both `UserModel.findById` and the Postgres-side
 * aggregation with a single, consistent `userId`.
 */
async function createLinkedUser(walletAddress: string): Promise<string> {
  const doc = await UserModel.create({
    walletAddress,
    joinedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastLoginAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const userId = doc._id.toString();
  await prisma.$executeRaw`INSERT INTO users (id, wallet_address, created_at, updated_at) VALUES (${userId}, ${walletAddress + "-pg"}, now(), now())`;
  return userId;
}

const hasDb = () => Boolean(process.env.DATABASE_URL);

describe("UsersController.me — aggregateStats (#1217)", () => {
  const controller = new UsersController(prisma);

  afterEach(async () => {
    if (!hasDb()) return;
    await cleanDb();
  });

  it("returns zero stats and null rank for a user with no participation", async () => {
    if (!hasDb()) return;

    const userId = await createLinkedUser("GNOPARTICIPATION1");
    const req = makeReq(userId);
    const res = makeRes();
    const next: NextFunction = () => {
      throw new Error("should not call next()");
    };

    await controller.me(req, res as unknown as Response, next);
    const body = res.captured as any;

    expect(body.gamesPlayed).toBe(0);
    expect(body.gamesWon).toBe(0);
    expect(body.totalYieldEarned).toBe("0.00");
    expect(body.currentRank).toBeNull();
  });

  it("counts games played/won and sums yield across multiple arenas", async () => {
    if (!hasDb()) return;

    const userId = await createLinkedUser("GSTATS0000000001");
    const other = await prisma.user.create({ data: { walletAddress: "GSTATS0000000002" } });
    const otherId = other.id;

    const arena1 = await prisma.arena.create({ data: {} });
    const arena2 = await prisma.arena.create({ data: {} });

    // Arena 1: target user participates and wins (never eliminated), earns yield 150.
    const r1 = await prisma.round.create({
      data: {
        arenaId: arena1.id,
        roundNumber: 1,
        state: "RESOLVED",
        metadata: {
          playerChoices: [
            { userId, choice: "heads", stake: 100 },
            { userId: otherId, choice: "tails", stake: 100 },
          ],
          resolution: {
            eliminatedPlayers: [otherId],
            payouts: [{ userId, amount: 150 }],
          },
        },
      },
    });
    await prisma.eliminationLog.create({
      data: { roundId: r1.id, userId: otherId, reason: "ELIMINATED_BY_ROUND" },
    });

    // Arena 2: target user participates but is eliminated (no payout).
    const r2 = await prisma.round.create({
      data: {
        arenaId: arena2.id,
        roundNumber: 1,
        state: "RESOLVED",
        metadata: {
          playerChoices: [
            { userId, choice: "heads", stake: 100 },
            { userId: otherId, choice: "tails", stake: 100 },
          ],
          resolution: {
            eliminatedPlayers: [userId],
            payouts: [{ userId: otherId, amount: 200 }],
          },
        },
      },
    });
    await prisma.eliminationLog.create({
      data: { roundId: r2.id, userId, reason: "ELIMINATED_BY_ROUND" },
    });

    const req = makeReq(userId);
    const res = makeRes();
    const next: NextFunction = () => {
      throw new Error("should not call next()");
    };

    await controller.me(req, res as unknown as Response, next);
    const body = res.captured as any;

    expect(body.gamesPlayed).toBe(2); // arena1 + arena2
    expect(body.gamesWon).toBe(1); // only arena1 (never eliminated there per metadata)
    expect(body.totalYieldEarned).toBe("150.00");
    // otherId (200) outranks userId (150) among users with any yield.
    expect(body.currentRank).toBe(2);
  });

  it("counts an elimination-only arena (no metadata participation) toward gamesPlayed but not gamesWon", async () => {
    if (!hasDb()) return;

    const userId = await createLinkedUser("GELIMONLY000001");
    const other = await prisma.user.create({ data: { walletAddress: "GELIMONLY000002" } });
    const otherId = other.id;

    const arena = await prisma.arena.create({ data: {} });
    const round = await prisma.round.create({
      data: {
        arenaId: arena.id,
        roundNumber: 1,
        state: "RESOLVED",
        // The target user is NOT present in playerChoices metadata at all —
        // only the elimination_logs table records their participation.
        metadata: {
          playerChoices: [{ userId: otherId, choice: "heads", stake: 100 }],
          resolution: { eliminatedPlayers: [userId], payouts: [] },
        },
      },
    });
    await prisma.eliminationLog.create({
      data: { roundId: round.id, userId, reason: "ELIMINATED_BY_ROUND" },
    });

    const req = makeReq(userId);
    const res = makeRes();
    const next: NextFunction = () => {
      throw new Error("should not call next()");
    };

    await controller.me(req, res as unknown as Response, next);
    const body = res.captured as any;

    expect(body.gamesPlayed).toBe(1); // union includes elimination-only arenas
    expect(body.gamesWon).toBe(0); // not eligible to "win" without metadata participation
    expect(body.totalYieldEarned).toBe("0.00");
    expect(body.currentRank).toBeNull();
  });

  it("returns 404 when the Mongo user identity is missing", async () => {
    if (!hasDb()) return;

    const req = makeReq("507f1f77bcf86cd799439011"); // valid ObjectId shape, not persisted
    const res = makeRes();
    let capturedError: unknown;
    const next: NextFunction = (err) => {
      capturedError = err;
    };

    await controller.me(req, res as unknown as Response, next);

    expect(capturedError).toBeDefined();
    expect((capturedError as { status?: number }).status).toBe(404);
  });
});
