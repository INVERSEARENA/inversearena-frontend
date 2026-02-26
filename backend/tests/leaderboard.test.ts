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

async function setupTestData() {
  // Clean slate
  await prisma.eliminationLog.deleteMany();
  await prisma.round.deleteMany();
  await prisma.arena.deleteMany();
  await prisma.user.deleteMany();

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

  // Wipe all game data
  await prisma.eliminationLog.deleteMany();
  await prisma.round.deleteMany();
  await prisma.arena.deleteMany();
  await prisma.user.deleteMany();

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

async function runTests() {
  try {
    await testNonEmptyLeaderboard();
    await testEmptyLeaderboard();
    await testPagination();
    console.log("\n🎉 All leaderboard tests passed");
  } catch (error) {
    console.error("Test suite failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runTests();
