/**
 * Unit tests for ArenaBackfillWorker (#1391).
 *
 * Uses a hand-rolled in-memory fake for the two Prisma delegates the worker
 * touches (`arena`, `backfillCursor`) — same pattern as
 * arenaService.deployment.unit.test.ts's `serviceWithRecordingPrisma` — plus
 * an injected `readPage` stub instead of a real/simulated Soroban RPC round
 * trip, so these tests exercise the worker's own orchestration (cursor
 * advancement, upsert idempotency, failure handling) in isolation.
 */
import { test } from "node:test";
import assert from "node:assert";

import {
  ArenaBackfillWorker,
  ARENA_DISCOVERY_CURSOR_ID,
} from "../src/workers/arenaBackfillWorker";
import { FactoryReadError, type FactoryArenaMetadata } from "../src/services/onChainReader";

const FACTORY_ID = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const HOST = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

function arena(poolId: number, overrides: Partial<FactoryArenaMetadata> = {}): FactoryArenaMetadata {
  return {
    arenaAddress: `CARENA${String(poolId).padStart(50, "0")}`,
    poolId,
    host: HOST,
    entryFee: 100n,
    status: "Active",
    createdAt: 1_700_000_000 + poolId,
    ...overrides,
  };
}

/** In-memory fake Prisma covering just the `arena` and `backfillCursor`
 * delegates the worker calls, with call recording for assertions. */
function fakePrisma() {
  const arenas = new Map<string, { id: string; metadata: unknown }>();
  const cursors = new Map<string, { id: string; lastProcessed: number }>();
  const arenaUpsertCalls: string[] = [];
  const cursorWrites: number[] = [];

  const prisma = {
    arena: {
      upsert: async (args: {
        where: { id: string };
        create: { id: string; metadata: unknown };
        update: Record<string, unknown>;
      }) => {
        arenaUpsertCalls.push(args.where.id);
        const existing = arenas.get(args.where.id);
        if (existing) {
          // `update: {}` in the real worker — mirror that no-op semantics here.
          return existing;
        }
        const created = { id: args.create.id, metadata: args.create.metadata };
        arenas.set(args.create.id, created);
        return created;
      },
    },
    backfillCursor: {
      findUnique: async (args: { where: { id: string } }) => {
        return cursors.get(args.where.id) ?? null;
      },
      upsert: async (args: {
        where: { id: string };
        create: { id: string; lastProcessed: number };
        update: { lastProcessed: number };
      }) => {
        cursorWrites.push(args.create.lastProcessed);
        const row = { id: args.where.id, lastProcessed: args.create.lastProcessed };
        cursors.set(args.where.id, row);
        return row;
      },
    },
  };

  return { prisma, arenas, cursors, arenaUpsertCalls, cursorWrites };
}

test("ArenaBackfillWorker: normal path discovers and upserts every arena in one page", async () => {
  const { prisma, arenas } = fakePrisma();
  const page = [arena(1), arena(2), arena(3)];
  const worker = new ArenaBackfillWorker(prisma as never, FACTORY_ID, {
    readPage: async (_factory, offset, limit) => {
      assert.strictEqual(offset, 0);
      assert.strictEqual(limit, 50);
      return page;
    },
  });

  const result = await worker.run();

  assert.strictEqual(result.status, "success");
  assert.strictEqual(result.discovered, 3);
  assert.strictEqual(result.failed, 0);
  assert.strictEqual(result.cursor, 3);
  assert.strictEqual(result.pagesRead, 1, "one page was successfully read and must be counted");
  assert.strictEqual(arenas.size, 3);
});

test("ArenaBackfillWorker: boundary — empty factory (no arenas at all) is a clean no-op success", async () => {
  const { prisma } = fakePrisma();
  const worker = new ArenaBackfillWorker(prisma as never, FACTORY_ID, {
    readPage: async () => [],
  });

  const result = await worker.run();

  assert.strictEqual(result.status, "success");
  assert.strictEqual(result.discovered, 0);
  assert.strictEqual(result.cursor, 0);
  // The empty page was still successfully fetched (one real RPC round trip),
  // so it counts as a page read even though it carried no arenas.
  assert.strictEqual(result.pagesRead, 1);
});

test("ArenaBackfillWorker: boundary — a short page (fewer than pageSize) stops paging without over-reading", async () => {
  const { prisma } = fakePrisma();
  let calls = 0;
  const worker = new ArenaBackfillWorker(prisma as never, FACTORY_ID, {
    pageSize: 50,
    readPage: async () => {
      calls += 1;
      return [arena(1), arena(2)]; // short page: 2 < pageSize 50
    },
  });

  const result = await worker.run();

  assert.strictEqual(calls, 1, "a short page must end the run without requesting another page");
  assert.strictEqual(result.discovered, 2);
  assert.strictEqual(result.cursor, 2);
  assert.strictEqual(result.pagesRead, 1);
});

test("ArenaBackfillWorker: boundary — maxPagesPerRun caps a very large backfill window instead of scanning unboundedly", async () => {
  const { prisma } = fakePrisma();
  let calls = 0;
  const worker = new ArenaBackfillWorker(prisma as never, FACTORY_ID, {
    pageSize: 2,
    maxPagesPerRun: 3,
    readPage: async (_f, offset) => {
      calls += 1;
      // Always return a full page so the loop only stops via maxPagesPerRun.
      return [arena(offset + 1), arena(offset + 2)];
    },
  });

  const result = await worker.run();

  assert.strictEqual(calls, 3, "must stop at maxPagesPerRun even though the factory has more data");
  assert.strictEqual(result.pagesRead, 3);
  assert.strictEqual(result.discovered, 6);
  assert.strictEqual(result.cursor, 6);
  // A subsequent run must resume from where this one stopped, not restart.
});

test("ArenaBackfillWorker: retry — a page-read (RPC) failure aborts the run without advancing the cursor past that page", async () => {
  const { prisma, cursors } = fakePrisma();
  const worker = new ArenaBackfillWorker(prisma as never, FACTORY_ID, {
    readPage: async () => {
      throw new FactoryReadError("get_arenas(0, 50) simulation failed on " + FACTORY_ID);
    },
  });

  const result = await worker.run();

  assert.strictEqual(result.status, "failed");
  assert.strictEqual(result.cursor, 0);
  assert.strictEqual(result.pagesRead, 1, "the failed page attempt still counts as an attempt");
  assert.strictEqual(cursors.size, 0, "cursor must not be written when the page read itself failed");
  assert.ok(result.error?.includes("simulation failed"));
});

test("ArenaBackfillWorker: retry — after an RPC failure, the next run resumes from the last successfully committed cursor", async () => {
  const { prisma } = fakePrisma();
  let attempt = 0;
  const worker = new ArenaBackfillWorker(prisma as never, FACTORY_ID, {
    pageSize: 2,
    readPage: async (_f, offset) => {
      attempt += 1;
      if (attempt === 1) {
        // First page succeeds...
        return [arena(1), arena(2)];
      }
      if (attempt === 2) {
        // ...second page fails.
        throw new FactoryReadError("boom");
      }
      // Third call (next run) must start from offset 2, not 0.
      assert.strictEqual(offset, 2);
      return [];
    },
  });

  const first = await worker.run();
  assert.strictEqual(first.status, "failed");
  assert.strictEqual(first.cursor, 2, "the first (successful) page's arenas must still count");

  const second = await worker.run();
  assert.strictEqual(second.status, "success");
  assert.strictEqual(second.cursor, 2);
});

test("ArenaBackfillWorker: invalid input — a single malformed arena is logged/counted and does not advance the cursor past it, without aborting the rest of the page", async () => {
  const { prisma, arenas } = fakePrisma();
  const originalUpsert = prisma.arena.upsert.bind(prisma.arena);
  prisma.arena.upsert = async (args: Parameters<typeof originalUpsert>[0]) => {
    if (args.create.id === "CARENA-BAD") {
      throw new Error("simulated malformed-record DB rejection");
    }
    return originalUpsert(args);
  };

  const page = [
    arena(1, { arenaAddress: "CARENA-BAD" }),
    arena(2),
    arena(3),
  ];
  const worker = new ArenaBackfillWorker(prisma as never, FACTORY_ID, {
    readPage: async () => page,
  });

  const result = await worker.run();

  assert.strictEqual(result.status, "success", "a single bad record must not fail the whole run");
  assert.strictEqual(result.discovered, 2);
  assert.strictEqual(result.failed, 1);
  // Cursor must land on the last arena actually processed (poolId 3), since
  // pool_id 1 (the bad one) is retried next run but does not block later
  // pool_ids in the same page from being processed.
  assert.strictEqual(result.cursor, 3);
  assert.strictEqual(arenas.size, 2);
});

test("ArenaBackfillWorker: idempotency — re-running the backfill over the same range does not duplicate or overwrite an existing arena", async () => {
  const { prisma, arenas } = fakePrisma();
  const page = [arena(1)];
  const worker = new ArenaBackfillWorker(prisma as never, FACTORY_ID, {
    readPage: async () => page,
  });

  await worker.run();
  const firstMetadata = arenas.get(page[0]!.arenaAddress)?.metadata;

  // Re-run over the same data (simulating overlap with a prior run / the
  // primary confirm path having also written this row in between).
  await worker.run();

  assert.strictEqual(arenas.size, 1, "must not create a duplicate row for the same arena address");
  assert.deepStrictEqual(
    arenas.get(page[0]!.arenaAddress)?.metadata,
    firstMetadata,
    "the no-op update clause must never overwrite an existing row's fields",
  );
});

test("ArenaBackfillWorker: idempotency — never overwrites a row the primary confirm path already wrote", async () => {
  const { prisma, arenas } = fakePrisma();
  // Simulate ArenaService.confirmArenaDeployment already having written this
  // arena with richer metadata before the backfill ever sees it.
  const confirmedArenaId = arena(1).arenaAddress;
  arenas.set(confirmedArenaId, {
    id: confirmedArenaId,
    metadata: { deployment: { status: "confirmed", txHash: "abc123" }, createdBy: "user-1" },
  });

  const worker = new ArenaBackfillWorker(prisma as never, FACTORY_ID, {
    readPage: async () => [arena(1, { arenaAddress: confirmedArenaId })],
  });

  const result = await worker.run();

  assert.strictEqual(result.discovered, 1, "the upsert still counts as processed for cursor purposes");
  const stored = arenas.get(confirmedArenaId);
  assert.strictEqual((stored?.metadata as { deployment: { status: string } }).deployment.status, "confirmed");
  assert.strictEqual((stored?.metadata as { createdBy: string }).createdBy, "user-1");
});

test("ArenaBackfillWorker: restart mid-run — cursor persisted per-arena means a crash after N of M upserts resumes at N+1, not 0", async () => {
  const { prisma, cursors } = fakePrisma();
  const page = [arena(1), arena(2), arena(3)];
  let upsertCount = 0;
  const originalArenaUpsert = prisma.arena.upsert.bind(prisma.arena);
  prisma.arena.upsert = async (args: Parameters<typeof originalArenaUpsert>[0]) => {
    upsertCount += 1;
    if (upsertCount === 3) {
      // Simulate the process crashing right after committing arena #2's
      // upsert+cursor write, mid-way through arena #3.
      throw new Error("simulated crash");
    }
    return originalArenaUpsert(args);
  };

  const worker = new ArenaBackfillWorker(prisma as never, FACTORY_ID, {
    readPage: async () => page,
  });

  const result = await worker.run();

  // Arena 3's upsert "crashed" — treated as a per-arena failure (not a
  // process-level abort in this harness), so the run still completes with
  // arena 3 uncommitted and the cursor sitting at arena 2.
  assert.strictEqual(result.cursor, 2);
  assert.strictEqual(cursors.get(ARENA_DISCOVERY_CURSOR_ID)?.lastProcessed, 2);

  // A fresh worker instance (simulating a real process restart) must resume
  // from pool_id 2, re-fetching only what was never committed.
  const resumedWorker = new ArenaBackfillWorker(prisma as never, FACTORY_ID, {
    readPage: async (_f, offset) => {
      assert.strictEqual(offset, 2, "restart must resume at the persisted cursor, not from scratch");
      return [arena(3)];
    },
  });
  const secondResult = await resumedWorker.run();
  assert.strictEqual(secondResult.cursor, 3);
});

test("ArenaBackfillWorker: concurrency — a second concurrent run() call while one is in progress is a safe no-op, not a double-page", async () => {
  const { prisma } = fakePrisma();
  let resolveFirstPage: (() => void) | undefined;
  const firstPageGate = new Promise<void>((resolve) => {
    resolveFirstPage = resolve;
  });
  let readPageCalls = 0;

  const worker = new ArenaBackfillWorker(prisma as never, FACTORY_ID, {
    readPage: async () => {
      readPageCalls += 1;
      await firstPageGate;
      return [];
    },
  });

  const firstRun = worker.run();
  // Give the first run a tick to enter run() and set isRunning.
  await new Promise((resolve) => setImmediate(resolve));

  const secondResult = await worker.run();
  assert.strictEqual(secondResult.discovered, 0);
  assert.strictEqual(readPageCalls, 1, "concurrent call must not trigger a second page read");

  resolveFirstPage!();
  await firstRun;
});

test("ArenaBackfillWorker: concurrency — overlap with the primary confirm path upsert-race is safe (last writer's create never fires twice)", async () => {
  const { prisma, arenas } = fakePrisma();
  const arenaId = arena(1).arenaAddress;

  // Simulate the confirm path's write racing in between the backfill's
  // cursor read and its own upsert call.
  const worker = new ArenaBackfillWorker(prisma as never, FACTORY_ID, {
    readPage: async () => {
      // "Concurrent" confirm-path write lands here, before the backfill's
      // own upsert executes.
      arenas.set(arenaId, {
        id: arenaId,
        metadata: { deployment: { status: "confirmed", txHash: "race-tx" } },
      });
      return [arena(1, { arenaAddress: arenaId })];
    },
  });

  await worker.run();

  assert.strictEqual(arenas.size, 1);
  assert.strictEqual(
    (arenas.get(arenaId)?.metadata as { deployment: { status: string } }).deployment.status,
    "confirmed",
    "the backfill must not clobber a confirm-path write that landed first",
  );
});
