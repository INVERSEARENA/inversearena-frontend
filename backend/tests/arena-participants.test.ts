import { PrismaClient } from "@prisma/client";
import { ArenaController } from "../src/controllers/arena.controller";
import type { Request, Response } from "express";

const prisma = new PrismaClient();

// ── Minimal req/res mocks ──────────────────────────────────────────
function makeReq(params: Record<string, string> = {}, query: Record<string, string> = {}): Request {
  return { params, query } as unknown as Request;
}

function makeRes(): {
  json: (body: unknown) => void;
  captured: unknown;
  status: (code: number) => { json: (b: unknown) => void };
  statusCode?: number;
} {
  const res = {
    captured: undefined as unknown,
    statusCode: undefined as number | undefined,
    json(body: unknown) {
      this.captured = body;
    },
    status(code: number) {
      this.statusCode = code;
      return {
        json: (b: unknown) => {
          res.captured = b;
        },
      };
    },
  };
  return res;
}

async function setupTestData() {
  // Clean slate
  await prisma.eliminationLog.deleteMany();
  await prisma.round.deleteMany();
  await prisma.pool.deleteMany();
  await prisma.arena.deleteMany();
  await prisma.user.deleteMany();

  // Create arena
  const arena = await prisma.arena.create({
    data: {
      metadata: { minStake: 100 },
    },
  });

  // Create users
  const [u1, u2, u3, u4, u5] = await Promise.all([
    prisma.user.create({ data: { walletAddress: "GAAA1111" } }),
    prisma.user.create({ data: { walletAddress: "GBBB2222" } }),
    prisma.user.create({ data: { walletAddress: "GCCC3333" } }),
    prisma.user.create({ data: { walletAddress: "GDDD4444" } }),
    prisma.user.create({ data: { walletAddress: "GEEE5555" } }),
  ]);

  // Create first round with all participants
  const round1 = await prisma.round.create({
    data: {
      arenaId: arena.id,
      roundNumber: 1,
      state: "RESOLVED",
      metadata: {
        playerChoices: [
          { userId: u1.id, choice: "HIGH", stake: 100 },
          { userId: u2.id, choice: "LOW", stake: 100 },
          { userId: u3.id, choice: "HIGH", stake: 100 },
          { userId: u4.id, choice: "LOW", stake: 100 },
          { userId: u5.id, choice: "HIGH", stake: 100 },
        ],
        resolution: {
          eliminatedPlayers: [u2.id, u4.id],
        },
      },
    },
  });

  // Create elimination logs for eliminated players
  await prisma.eliminationLog.createMany({
    data: [
      { roundId: round1.id, userId: u2.id, reason: "ELIMINATED_BY_ROUND" },
      { roundId: round1.id, userId: u4.id, reason: "ELIMINATED_BY_ROUND" },
    ],
  });

  return { arena, u1, u2, u3, u4, u5 };
}

// ── Tests ──────────────────────────────────────────────────────────

async function testFirstPage() {
  console.log("🧪 Test: First page returns participants with correct status");

  const { arena, u1, u2, u3, u4, u5 } = await setupTestData();
  const controller = new ArenaController(prisma);
  const res = makeRes();

  await controller.getParticipants(
    makeReq({ id: arena.id }),
    res as unknown as Response
  );

  const body = res.captured as {
    items: Array<{ walletAddress: string; status: string; joinedAt: string }>;
    cursor: string | null;
    hasMore: boolean;
  };

  const assertions = [
    body.items.length === 5,
    body.hasMore === false,
    body.cursor === null,

    // Check that all participants are present
    body.items.some((p) => p.walletAddress === "GAAA1111" && p.status === "active"),
    body.items.some((p) => p.walletAddress === "GBBB2222" && p.status === "eliminated"),
    body.items.some((p) => p.walletAddress === "GCCC3333" && p.status === "active"),
    body.items.some((p) => p.walletAddress === "GDDD4444" && p.status === "eliminated"),
    body.items.some((p) => p.walletAddress === "GEEE5555" && p.status === "active"),

    // Check that joinedAt is present and valid ISO string
    body.items.every((p) => p.joinedAt && !isNaN(Date.parse(p.joinedAt))),
  ];

  if (assertions.every(Boolean)) {
    console.log("✅ PASS: First page returns all participants with correct status");
  } else {
    console.log("❌ FAIL: First page assertions failed");
    console.log("Received:", JSON.stringify(body, null, 2));
    process.exit(1);
  }
}

async function testPagination() {
  console.log("\n🧪 Test: Pagination works across pages");

  const { arena } = await setupTestData();
  const controller = new ArenaController(prisma);

  // Fetch first page (limit=2)
  const res1 = makeRes();
  await controller.getParticipants(
    makeReq({ id: arena.id }, { limit: "2" }),
    res1 as unknown as Response
  );
  const page1 = res1.captured as {
    items: Array<{ walletAddress: string }>;
    cursor: string | null;
    hasMore: boolean;
  };

  // Fetch second page using cursor
  const res2 = makeRes();
  await controller.getParticipants(
    makeReq({ id: arena.id }, { limit: "2", cursor: page1.cursor! }),
    res2 as unknown as Response
  );
  const page2 = res2.captured as {
    items: Array<{ walletAddress: string }>;
    cursor: string | null;
    hasMore: boolean;
  };

  // Fetch third page (last page)
  const res3 = makeRes();
  await controller.getParticipants(
    makeReq({ id: arena.id }, { limit: "2", cursor: page2.cursor! }),
    res3 as unknown as Response
  );
  const page3 = res3.captured as {
    items: Array<{ walletAddress: string }>;
    cursor: string | null;
    hasMore: boolean;
  };

  const assertions = [
    // Page 1
    page1.items.length === 2,
    page1.hasMore === true,
    page1.cursor !== null,

    // Page 2
    page2.items.length === 2,
    page2.hasMore === true,
    page2.cursor !== null,

    // Page 3 (last page)
    page3.items.length === 1,
    page3.hasMore === false,
    page3.cursor === null,

    // No duplicates across pages
    new Set([
      ...page1.items.map((p) => p.walletAddress),
      ...page2.items.map((p) => p.walletAddress),
      ...page3.items.map((p) => p.walletAddress),
    ]).size === 5,
  ];

  if (assertions.every(Boolean)) {
    console.log("✅ PASS: Pagination works correctly across pages");
  } else {
    console.log("❌ FAIL: Pagination assertions failed");
    console.log("Page1:", JSON.stringify(page1));
    console.log("Page2:", JSON.stringify(page2));
    console.log("Page3:", JSON.stringify(page3));
    process.exit(1);
  }
}

async function testLastPage() {
  console.log("\n🧪 Test: Last page has hasMore=false and cursor=null");

  const { arena } = await setupTestData();
  const controller = new ArenaController(prisma);

  // Fetch with limit larger than total participants
  const res = makeRes();
  await controller.getParticipants(
    makeReq({ id: arena.id }, { limit: "100" }),
    res as unknown as Response
  );
  const body = res.captured as {
    items: Array<{ walletAddress: string }>;
    cursor: string | null;
    hasMore: boolean;
  };

  const assertions = [
    body.items.length === 5,
    body.hasMore === false,
    body.cursor === null,
  ];

  if (assertions.every(Boolean)) {
    console.log("✅ PASS: Last page correctly indicates no more data");
  } else {
    console.log("❌ FAIL: Last page assertions failed");
    console.log("Received:", JSON.stringify(body, null, 2));
    process.exit(1);
  }
}

async function testUnknownArena() {
  console.log("\n🧪 Test: Unknown arena returns 404");

  await setupTestData();
  const controller = new ArenaController(prisma);
  const res = makeRes();

  await controller.getParticipants(
    makeReq({ id: "00000000-0000-0000-0000-000000000000" }),
    res as unknown as Response
  );

  const body = res.captured as { error: string };

  const assertions = [
    res.statusCode === 404,
    body.error.includes("not found"),
  ];

  if (assertions.every(Boolean)) {
    console.log("✅ PASS: Unknown arena returns 404");
  } else {
    console.log("❌ FAIL: Unknown arena test failed");
    console.log("Status:", res.statusCode);
    console.log("Body:", JSON.stringify(body, null, 2));
    process.exit(1);
  }
}

async function testEmptyArena() {
  console.log("\n🧪 Test: Arena with no rounds returns empty list");

  // Clean slate
  await prisma.eliminationLog.deleteMany();
  await prisma.round.deleteMany();
  await prisma.pool.deleteMany();
  await prisma.arena.deleteMany();
  await prisma.user.deleteMany();

  // Create arena with no rounds
  const arena = await prisma.arena.create({
    data: { metadata: { minStake: 100 } },
  });

  const controller = new ArenaController(prisma);
  const res = makeRes();

  await controller.getParticipants(
    makeReq({ id: arena.id }),
    res as unknown as Response
  );

  const body = res.captured as {
    items: Array<unknown>;
    cursor: string | null;
    hasMore: boolean;
  };

  const assertions = [
    body.items.length === 0,
    body.hasMore === false,
    body.cursor === null,
  ];

  if (assertions.every(Boolean)) {
    console.log("✅ PASS: Empty arena returns empty list");
  } else {
    console.log("❌ FAIL: Empty arena test failed");
    console.log("Received:", JSON.stringify(body, null, 2));
    process.exit(1);
  }
}

async function testDefaultLimit() {
  console.log("\n🧪 Test: Default limit is 25");

  const { arena } = await setupTestData();
  const controller = new ArenaController(prisma);
  const res = makeRes();

  // Don't specify limit
  await controller.getParticipants(
    makeReq({ id: arena.id }),
    res as unknown as Response
  );

  const body = res.captured as {
    items: Array<unknown>;
    cursor: string | null;
    hasMore: boolean;
  };

  // With 5 participants and default limit 25, should get all in one page
  const assertions = [
    body.items.length === 5,
    body.hasMore === false,
    body.cursor === null,
  ];

  if (assertions.every(Boolean)) {
    console.log("✅ PASS: Default limit works correctly");
  } else {
    console.log("❌ FAIL: Default limit test failed");
    console.log("Received:", JSON.stringify(body, null, 2));
    process.exit(1);
  }
}

async function runTests() {
  try {
    await testFirstPage();
    await testPagination();
    await testLastPage();
    await testUnknownArena();
    await testEmptyArena();
    await testDefaultLimit();
    console.log("\n🎉 All arena participants tests passed");
  } catch (error) {
    console.error("Test suite failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runTests();
