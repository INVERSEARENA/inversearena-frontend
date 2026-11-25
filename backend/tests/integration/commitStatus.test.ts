import express from "express";
import request from "supertest";
import { prisma } from "../../src/db/prisma";
import { createArenasRouter } from "../../src/routes/arenas";
import { errorHandler } from "../../src/middleware/errorHandler";

/**
 * Integration test for GET /api/arenas/:id/rounds/:roundNumber/commit-status
 * (#1383). Unlike tests/commitStatus.route.unit.test.ts (which mocks
 * prisma), this exercises the real cross-module flow against a live
 * Postgres database: Express router -> RoundService.getCommitStatus ->
 * RoundRepository.findByArenaAndNumber / prisma.user.findUnique -> Postgres.
 *
 * Matches the style of test/integration/pool.test.ts: uses the real
 * `prisma` client, requires DATABASE_URL, and is a no-op (not a failure)
 * when it isn't set, same as that file's own early return.
 */

function authMiddlewareFor(wallet: string) {
  return (req: any, _res: any, next: any) => {
    req.user = { id: "auth-user", walletAddress: wallet, jti: "jti-1" };
    next();
  };
}

function buildApp(wallet: string): express.Express {
  const app = express();
  app.use("/api/arenas", createArenasRouter(authMiddlewareFor(wallet)));
  app.use(errorHandler);
  return app;
}

describe("Commit-status endpoint integration (#1383)", () => {
  if (!process.env.DATABASE_URL) {
    it("skipped: DATABASE_URL not set", () => {
      expect(true).toBe(true);
    });
    return;
  }

  const WALLET_A = `commit-status-wallet-a-${Date.now()}`;
  const WALLET_B = `commit-status-wallet-b-${Date.now()}`;

  let arenaId: string;
  let userAId: string;

  beforeAll(async () => {
    const arena = await prisma.arena.create({ data: { metadata: { entryFee: 100 } } });
    arenaId = arena.id;

    const userA = await prisma.user.create({ data: { walletAddress: WALLET_A } });
    userAId = userA.id;
    await prisma.user.create({ data: { walletAddress: WALLET_B } });
  });

  afterAll(async () => {
    await prisma.round.deleteMany({ where: { arenaId } });
    await prisma.arena.delete({ where: { id: arenaId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { walletAddress: { in: [WALLET_A, WALLET_B] } } });
  });

  it("returns missing/ROUND_NOT_FOUND for a round number that was never created", async () => {
    const app = buildApp(WALLET_A);

    const response = await request(app).get(`/api/arenas/${arenaId}/rounds/1/commit-status`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      arenaId,
      roundNumber: 1,
      walletAddress: WALLET_A,
      status: "missing",
      reason: "ROUND_NOT_FOUND",
    });
  });

  it("returns pending for a real OPEN round with no recorded choice", async () => {
    const round = await prisma.round.create({
      data: { arenaId, roundNumber: 2, state: "OPEN" },
    });

    const app = buildApp(WALLET_A);
    const response = await request(app).get(`/api/arenas/${arenaId}/rounds/${round.roundNumber}/commit-status`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("pending");
  });

  it("returns expired for a real CLOSED round with no recorded choice", async () => {
    const round = await prisma.round.create({
      data: { arenaId, roundNumber: 3, state: "CLOSED" },
    });

    const app = buildApp(WALLET_A);
    const response = await request(app).get(`/api/arenas/${arenaId}/rounds/${round.roundNumber}/commit-status`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("expired");
  });

  it("returns accepted with the revealed choice once a round resolves with this player's choice recorded", async () => {
    const round = await prisma.round.create({
      data: {
        arenaId,
        roundNumber: 4,
        state: "RESOLVED",
        metadata: {
          playerChoices: [{ userId: userAId, choice: "heads", stake: 100 }],
          oracleYield: 5,
        },
      },
    });

    const app = buildApp(WALLET_A);
    const response = await request(app).get(`/api/arenas/${arenaId}/rounds/${round.roundNumber}/commit-status`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("accepted");
    expect(response.body.choice).toBe("heads");
  });

  it("returns missing/NO_COMMIT_RECORDED for a different caller on the same resolved round (ownership boundary)", async () => {
    // Reuses round 4 from the previous test (created with only userA's choice).
    const app = buildApp(WALLET_B);
    const response = await request(app).get(`/api/arenas/${arenaId}/rounds/4/commit-status`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "missing", reason: "NO_COMMIT_RECORDED" });
  });

  it("returns 404 ARENA_NOT_FOUND for a real but unrelated/nonexistent arena id", async () => {
    const app = buildApp(WALLET_A);
    const response = await request(app).get(
      "/api/arenas/00000000-0000-0000-0000-000000000000/rounds/1/commit-status",
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("ARENA_NOT_FOUND");
  });

  it("rejects a malformed roundNumber with 400 before touching the database", async () => {
    const app = buildApp(WALLET_A);
    const response = await request(app).get(`/api/arenas/${arenaId}/rounds/-5/commit-status`);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});
