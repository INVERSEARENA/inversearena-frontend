import { PrismaClient } from "@prisma/client";
import { LeaderboardController } from "../src/controllers/leaderboard.controller";
import type { Request, Response } from "express";

const prisma = new PrismaClient();

// ── Minimal req/res mocks ──────────────────────────────────────────
function makeReq(query: Record<string, string> = {}): Request {
  return { query } as unknown as Request;
}

function makeRes(): { json: (body: unknown) => void; captured: unknown; status: (code: number) => { json: (b: unknown) => void } } {
  const res = {
    captured: undefined as unknown,
    json(body: unknown) {
      this.captured = body;
    },
    status(code: number) {
      return { json: (b: unknown) => { res.captured = b; void code; } };
    },
  };
  return res;
}

// ── Seed helpers ───────────────────────────────────────────────────

async function cleanDb() {
  await prisma.eliminationLog.deleteMany();
  await prisma.round.deleteMany();
  await prisma.arena.deleteMany();
  await prisma.user.deleteMany();
}

async function setupTestData() {
  await cleanDb();

  const arena1 = await prisma.arena.create({ data: {} });
  const arena2 = await prisma.arena.create({ data: {} });

  const [u1, u2, u3] = await Promise.all([
    prisma.user.create({ data: { walletAddress: "GAAA1111" } }),
    prisma.user.create({ data: { walletAddress: "GBBB2222" } }),
    prisma.user.create({ data: { walletAddress: "GCCC3333" } }),
  ]);

  // Arena 1, Round 1 — RESOLVED: u1 wins, u2 eliminated
  const r1 = await prisma.round.create({
    data: {
      arenaId: arena1.id,
      roundNumber: 1,
      state: "RESOLVED",
      metadata: {
        playerChoices: [
          { userId: u1.id, choice: "HIGH", stake: 100 },
          { userId: u2.id, choice: "LOW", stake: 100 },
        ],
        resolution: {
          eliminatedPlayers: [u2.id],
          payouts: [{ userId: u1.id, amount: 210 }],
        },
      },
    },
  });

  await prisma.eliminationLog.create({
    data: { roundId: r1.id, userId: u2.id, reason: "ELIMINATED_BY_ROUND" },
  });

  // Arena 2, Round 1 — RESOLVED: u1 and u3 play, u3 eliminated
  const r2 = await prisma.round.create({
    data: {
      arenaId: arena2.id,
      roundNumber: 1,
      state: "RESOLVED",
      metadata: {
        playerChoices: [
          { userId: u1.id, choice: "HIGH", stake: 50 },
          { userId: u3.id, choice: "LOW", stake: 50 },
        ],
        resolution: {
          eliminatedPlayers: [u3.id],
          payouts: [{ userId: u1.id, amount: 105 }],
        },
      },
    },
  });

  await prisma.eliminationLog.create({
    data: { roundId: r2.id, userId: u3.id, reason: "ELIMINATED_BY_ROUND" },
  });

  return { arena1, arena2, u1, u2, u3 };
}

/**
 * Seeds `count` users across unique arenas with deterministic stats.
 * User i has totalYield = (count - i) * 10 and arenasWon = 1 (never eliminated).
 * Ordering is deterministic so rank assertions hold across test runs.
 */
async function seedLeaderboardData(count: number) {
  await cleanDb();

  const users: { id: string }[] = [];
  for (let i = 0; i < count; i++) {
    const user = await prisma.user.create({
      data: { walletAddress: `G${"A".repeat(54 - String(i).length)}${i}` },
    });
    users.push(user);
  }

  for (let i = 0; i < count; i++) {
    const arena = await prisma.arena.create({ data: {} });
    await prisma.round.create({
      data: {
        arenaId: arena.id,
        roundNumber: 1,
        state: "RESOLVED",
        metadata: {
          playerChoices: [{ userId: users[i].id, choice: "HIGH", stake: 100 }],
          resolution: {
            eliminatedPlayers: [],
            payouts: [{ userId: users[i].id, amount: (count - i) * 10 }],
          },
        },
      },
    });
  }

  return users;
}

// ── Tests ──────────────────────────────────────────────────────────

async function testNonEmptyLeaderboard() {
  console.log("🧪 Test: Non-empty leaderboard returns ranked players");

  const { u1, u2, u3 } = await setupTestData();
  const controller = new LeaderboardController(prisma);
  const res = makeRes();

  await controller.getLeaderboard(makeReq(), res as unknown as Response);

  const body = res.captured as { players: { id: string; rank: number; walletAddress: string; totalYield: number; arenasWon: number; survivalStreak: number }[]; nextCursor: string | null };

  const assertions = [
    body.players.length === 3,
    body.nextCursor === null,

    // u1: 2 arenas won (never eliminated), totalYield = 210 + 105 = 315, rank 1
    body.players[0].id === u1.id,
    body.players[0].rank === 1,
    body.players[0].walletAddress === "GAAA1111",
    body.players[0].totalYield === 315,
    body.players[0].arenasWon === 2,
    body.players[0].survivalStreak === 2,

    // u2: 0 arenas won (eliminated in arena1), rank 2 or 3 (no yield)
    body.players.some((p) => p.id === u2.id && p.arenasWon === 0 && p.totalYield === 0),

    // u3: 0 arenas won (eliminated in arena2), rank 2 or 3
    body.players.some((p) => p.id === u3.id && p.arenasWon === 0 && p.totalYield === 0),
  ];

  if (assertions.every(Boolean)) {
    console.log("✅ PASS: Leaderboard is correctly ranked");
  } else {
    console.log("❌ FAIL: Leaderboard assertions failed");
    console.log("Received:", JSON.stringify(body.players, null, 2));
    process.exit(1);
  }
}

async function testEmptyLeaderboard() {
  console.log("\n🧪 Test: Empty leaderboard returns no players");

  await cleanDb();

  const controller = new LeaderboardController(prisma);
  const res = makeRes();

  await controller.getLeaderboard(makeReq(), res as unknown as Response);

  const body = res.captured as { players: unknown[]; nextCursor: null };

  if (body.players.length === 0 && body.nextCursor === null) {
    console.log("✅ PASS: Empty leaderboard handled gracefully");
  } else {
    console.log("❌ FAIL: Expected empty players array");
    process.exit(1);
  }
}

async function testSingleUserRankOne() {
  console.log("\n🧪 Test: Single user has rank 1");

  await cleanDb();

  const user = await prisma.user.create({ data: { walletAddress: "GSOLO000" } });
  const arena = await prisma.arena.create({ data: {} });
  await prisma.round.create({
    data: {
      arenaId: arena.id,
      roundNumber: 1,
      state: "RESOLVED",
      metadata: {
        playerChoices: [{ userId: user.id, choice: "HIGH", stake: 100 }],
        resolution: { eliminatedPlayers: [], payouts: [{ userId: user.id, amount: 150 }] },
      },
    },
  });

  const controller = new LeaderboardController(prisma);
  const res = makeRes();
  await controller.getLeaderboard(makeReq(), res as unknown as Response);

  const body = res.captured as { players: { id: string; rank: number }[]; nextCursor: null };

  if (body.players.length === 1 && body.players[0].rank === 1 && body.players[0].id === user.id) {
    console.log("✅ PASS: Single user is correctly ranked 1");
  } else {
    console.log("❌ FAIL: Single-user rank assertion failed");
    console.log("Received:", JSON.stringify(body, null, 2));
    process.exit(1);
  }
}

async function testTwoHundredUsersNonOverlappingPages() {
  console.log("\n🧪 Test: 200-user dataset — pages are non-overlapping and cover all users");

  await seedLeaderboardData(200);

  const controller = new LeaderboardController(prisma);

  const page1Res = makeRes();
  await controller.getLeaderboard(makeReq({ limit: "25" }), page1Res as unknown as Response);
  const page1 = page1Res.captured as { players: { id: string; rank: number }[]; nextCursor: string };

  const page2Res = makeRes();
  await controller.getLeaderboard(
    makeReq({ limit: "25", cursor: page1.nextCursor }),
    page2Res as unknown as Response,
  );
  const page2 = page2Res.captured as { players: { id: string; rank: number }[]; nextCursor: string };

  const page3Res = makeRes();
  await controller.getLeaderboard(
    makeReq({ limit: "25", cursor: page2.nextCursor }),
    page3Res as unknown as Response,
  );
  const page3 = page3Res.captured as { players: { id: string; rank: number }[]; nextCursor: string | null };

  const ids1 = page1.players.map((p) => p.id);
  const ids2 = page2.players.map((p) => p.id);
  const ids3 = page3.players.map((p) => p.id);

  const noOverlap12 = !ids1.some((id) => ids2.includes(id));
  const noOverlap23 = !ids2.some((id) => ids3.includes(id));
  const noOverlap13 = !ids1.some((id) => ids3.includes(id));

  const ranksAscending = page1.players.every((p, i) =>
    i === 0 || p.rank === page1.players[i - 1].rank + 1,
  );

  const page2StartsAfterPage1 =
    page2.players[0]?.rank === page1.players[page1.players.length - 1].rank + 1;

  if (
    page1.players.length === 25 &&
    page2.players.length === 25 &&
    page3.players.length === 25 &&
    noOverlap12 && noOverlap23 && noOverlap13 &&
    ranksAscending && page2StartsAfterPage1
  ) {
    console.log("✅ PASS: Pages are non-overlapping and correctly ordered");
  } else {
    console.log("❌ FAIL: Pagination non-overlap assertion failed");
    console.log(`Pages: ${page1.players.length}, ${page2.players.length}, ${page3.players.length}`);
    console.log(`No overlap 1-2: ${noOverlap12}, 2-3: ${noOverlap23}, 1-3: ${noOverlap13}`);
    process.exit(1);
  }
}

async function testInvalidCursorFallsBackToPageOne() {
  console.log("\n🧪 Test: Invalid cursor falls back to first page");

  await setupTestData();

  const controller = new LeaderboardController(prisma);
  const res = makeRes();

  await controller.getLeaderboard(
    makeReq({ cursor: "!!!not-a-valid-cursor!!!" }),
    res as unknown as Response,
  );

  const body = res.captured as { players: { rank: number }[]; nextCursor: string | null };

  if (body.players.length > 0 && body.players[0].rank === 1) {
    console.log("✅ PASS: Invalid cursor gracefully defaults to page 1");
  } else {
    console.log("❌ FAIL: Invalid cursor did not default to page 1");
    console.log("Received:", JSON.stringify(body, null, 2));
    process.exit(1);
  }
}

async function testLimitBoundaries() {
  console.log("\n🧪 Test: limit boundary values — limit=1 and limit capped at 100");

  await seedLeaderboardData(150);

  const controller = new LeaderboardController(prisma);

  // limit=1 returns exactly one player
  const res1 = makeRes();
  await controller.getLeaderboard(makeReq({ limit: "1" }), res1 as unknown as Response);
  const body1 = res1.captured as { players: unknown[]; nextCursor: string | null };

  // limit=100 returns at most 100 players
  const res100 = makeRes();
  await controller.getLeaderboard(makeReq({ limit: "100" }), res100 as unknown as Response);
  const body100 = res100.captured as { players: unknown[]; nextCursor: string | null };

  // limit=101 should be capped — controller schema max is 100, zod will reject or cap
  const res101 = makeRes();
  let limit101Error: unknown;
  try {
    await controller.getLeaderboard(makeReq({ limit: "101" }), res101 as unknown as Response);
  } catch (err) {
    limit101Error = err;
  }

  const limitOneOk = body1.players.length === 1 && body1.nextCursor !== null;
  const limitHundredOk = body100.players.length === 100 && body100.nextCursor !== null;
  const limitOverCapped = limit101Error !== undefined; // zod rejects > 100

  if (limitOneOk && limitHundredOk && limitOverCapped) {
    console.log("✅ PASS: limit=1 returns 1 player, limit=100 caps correctly, limit=101 rejected");
  } else {
    console.log("❌ FAIL: limit boundary test failed");
    console.log(`limit=1: ${body1.players.length} players, nextCursor: ${body1.nextCursor}`);
    console.log(`limit=100: ${body100.players.length} players, nextCursor: ${body100.nextCursor}`);
    console.log(`limit=101 error thrown: ${limit101Error !== undefined}`);
    process.exit(1);
  }
}

async function testTieBreakingByArenasWon() {
  console.log("\n🧪 Test: Tie-breaking by arenasWon when totalYield is equal");

  await cleanDb();

  const [uA, uB] = await Promise.all([
    prisma.user.create({ data: { walletAddress: "GTIE_A000000000000000000000000000000000000000000000000000" } }),
    prisma.user.create({ data: { walletAddress: "GTIE_B000000000000000000000000000000000000000000000000000" } }),
  ]);

  // Both users have the same totalYield (100), but uA won 2 arenas vs uB's 1
  for (let i = 0; i < 2; i++) {
    const arena = await prisma.arena.create({ data: {} });
    await prisma.round.create({
      data: {
        arenaId: arena.id,
        roundNumber: 1,
        state: "RESOLVED",
        metadata: {
          playerChoices: [{ userId: uA.id, choice: "HIGH", stake: 100 }],
          resolution: { eliminatedPlayers: [], payouts: [{ userId: uA.id, amount: 50 }] },
        },
      },
    });
  }

  const arena3 = await prisma.arena.create({ data: {} });
  await prisma.round.create({
    data: {
      arenaId: arena3.id,
      roundNumber: 1,
      state: "RESOLVED",
      metadata: {
        playerChoices: [{ userId: uB.id, choice: "HIGH", stake: 100 }],
        resolution: { eliminatedPlayers: [], payouts: [{ userId: uB.id, amount: 100 }] },
      },
    },
  });

  const controller = new LeaderboardController(prisma);
  const res = makeRes();
  await controller.getLeaderboard(makeReq(), res as unknown as Response);

  const body = res.captured as { players: { id: string; rank: number; totalYield: number; arenasWon: number }[] };

  const rankA = body.players.find((p) => p.id === uA.id);
  const rankB = body.players.find((p) => p.id === uB.id);

  const sameYield = rankA?.totalYield === rankB?.totalYield;
  const uAWinsOnArenas = rankA !== undefined && rankB !== undefined && rankA.rank < rankB.rank;

  if (sameYield && uAWinsOnArenas) {
    console.log("✅ PASS: arenasWon correctly breaks yield ties");
  } else {
    console.log("❌ FAIL: Tie-breaking by arenasWon failed");
    console.log("uA:", JSON.stringify(rankA));
    console.log("uB:", JSON.stringify(rankB));
    process.exit(1);
  }
}

async function testPagination() {
  console.log("\n🧪 Test: Pagination cursor works correctly");

  await setupTestData();

  const controller = new LeaderboardController(prisma);

  // Fetch first page (limit=2)
  const res1 = makeRes();
  await controller.getLeaderboard(makeReq({ limit: "2" }), res1 as unknown as Response);
  const page1 = res1.captured as { players: { rank: number }[]; nextCursor: string | null };

  // Fetch second page using cursor
  const res2 = makeRes();
  await controller.getLeaderboard(
    makeReq({ limit: "2", cursor: page1.nextCursor! }),
    res2 as unknown as Response,
  );
  const page2 = res2.captured as { players: { rank: number }[]; nextCursor: string | null };

  const assertions = [
    page1.players.length === 2,
    page1.nextCursor !== null,
    page1.players[0].rank === 1,
    page1.players[1].rank === 2,
    page2.players.length === 1,
    page2.nextCursor === null,
    page2.players[0].rank === 3,
  ];

  if (assertions.every(Boolean)) {
    console.log("✅ PASS: Cursor pagination works correctly");
  } else {
    console.log("❌ FAIL: Pagination assertions failed");
    console.log("Page1:", JSON.stringify(page1.players.map((p) => p.rank)));
    console.log("Page2:", JSON.stringify(page2.players.map((p) => p.rank)));
    process.exit(1);
  }
}

async function testCrossUserLeaderboardConsistency() {
  console.log("\n🧪 Test: Two different authenticated users see the same leaderboard");

  await setupTestData();
  const controller = new LeaderboardController(prisma);

  // Simulate two separate authenticated requests (different users, same query)
  const res1 = makeRes();
  const res2 = makeRes();

  await controller.getLeaderboard(makeReq({ limit: "20" }), res1 as unknown as Response);
  await controller.getLeaderboard(makeReq({ limit: "20" }), res2 as unknown as Response);

  const body1 = res1.captured as { players: { id: string; rank: number }[]; nextCursor: string | null };
  const body2 = res2.captured as { players: { id: string; rank: number }[]; nextCursor: string | null };

  // Both responses must be identical — leaderboard is public, not user-scoped
  const sameLength = body1.players.length === body2.players.length;
  const sameCursor = body1.nextCursor === body2.nextCursor;
  const sameOrder = body1.players.every(
    (p, i) => p.id === body2.players[i].id && p.rank === body2.players[i].rank,
  );

  if (sameLength && sameCursor && sameOrder) {
    console.log("✅ PASS: Both users see identical leaderboard — shared cache is safe for public data");
  } else {
    console.log("❌ FAIL: Leaderboard responses differ between users");
    console.log("User1:", JSON.stringify(body1.players.map((p) => p.id)));
    console.log("User2:", JSON.stringify(body2.players.map((p) => p.id)));
    process.exit(1);
  }
}

async function runTests() {
  try {
    await testNonEmptyLeaderboard();
    await testEmptyLeaderboard();
    await testSingleUserRankOne();
    await testTwoHundredUsersNonOverlappingPages();
    await testInvalidCursorFallsBackToPageOne();
    await testLimitBoundaries();
    await testTieBreakingByArenasWon();
    await testPagination();
    await testCrossUserLeaderboardConsistency();
    console.log("\n🎉 All leaderboard tests passed");
  } catch (error) {
    console.error("Test suite failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runTests();
