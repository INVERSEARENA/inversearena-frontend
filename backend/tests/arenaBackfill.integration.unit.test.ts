/**
 * Cross-module integration test for #1391: factory contract reads
 * (onChainReader.getFactoryArenaPage) -> backfill worker orchestration
 * (ArenaBackfillWorker) -> DB upsert, exercised together rather than each
 * module in isolation.
 *
 * Simulates the actual failure scenario the issue describes: two arenas'
 * on-chain create_pool calls succeeded, but only one had its
 * POST /api/arenas confirmation land (the other is a "gap" — e.g. the
 * client crashed after the on-chain call but before confirming). The
 * backfill worker must discover the missed arena, leave the already-known
 * one untouched, and produce no duplicate rows — end to end, through the
 * real ScVal encode/decode path (no readPage stub), only the RPC transport
 * itself is stubbed via onChainReader's `setRpcServerForTest` seam.
 */
import { test } from "node:test";
import assert from "node:assert";
import { Address, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";

import { setRpcServerForTest } from "../src/services/onChainReader";
import { ArenaBackfillWorker, ARENA_DISCOVERY_CURSOR_ID } from "../src/workers/arenaBackfillWorker";

process.env.SOROBAN_RPC_URL ??= "https://soroban-testnet.stellar.org";
process.env.STELLAR_NETWORK_PASSPHRASE ??= "Test SDF Network ; September 2015";

const FACTORY_ID = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const CONFIRMED_ARENA_ID = "CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3";
const MISSED_ARENA_ID = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";
const HOST = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

interface ArenaFixtureInput {
  arena_address: string;
  pool_id: number;
  host: string;
  entry_fee: bigint;
  status: "Pending" | "Active" | "Finished" | "Cancelled";
  created_at: number;
}

function encodeArenaMetadata(a: ArenaFixtureInput): xdr.ScVal {
  const entries = [
    new xdr.ScMapEntry({
      key: nativeToScVal("arena_address", { type: "symbol" }),
      val: new Address(a.arena_address).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("created_at", { type: "symbol" }),
      val: nativeToScVal(a.created_at, { type: "u64" }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("entry_fee", { type: "symbol" }),
      val: nativeToScVal(a.entry_fee, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("host", { type: "symbol" }),
      val: new Address(a.host).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("pool_id", { type: "symbol" }),
      val: nativeToScVal(a.pool_id, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("status", { type: "symbol" }),
      val: xdr.ScVal.scvVec([nativeToScVal(a.status, { type: "symbol" })]),
    }),
  ];
  return xdr.ScVal.scvMap(entries);
}

/** Stubs the factory's live `get_arenas(offset, limit)` state: two pools
 * exist on-chain (pool_id 1 and 2), mirroring what a real deployment would
 * report regardless of what the backend's DB already knows about. */
function stubFactoryServer(): rpc.Server {
  const allArenas: ArenaFixtureInput[] = [
    {
      arena_address: CONFIRMED_ARENA_ID,
      pool_id: 1,
      host: HOST,
      entry_fee: 500n,
      status: "Active",
      created_at: 1_700_000_000,
    },
    {
      arena_address: MISSED_ARENA_ID,
      pool_id: 2,
      host: HOST,
      entry_fee: 750n,
      status: "Active",
      created_at: 1_700_000_050,
    },
  ];

  return {
    getAccount: async () => ({
      accountId: () => HOST,
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    }),
    simulateTransaction: async (tx: { operations: Array<{ func: xdr.HostFunction }> }) => {
      const invoke = tx.operations[0]!.func.invokeContract();
      const args = invoke.args();
      const offset = Number(args[0]!.u32());
      const limit = Math.min(Number(args[1]!.u32()), 50);
      const page = allArenas.filter((a) => a.pool_id > offset && a.pool_id <= offset + limit);
      return {
        transactionData: {},
        result: { retval: xdr.ScVal.scvVec(page.map(encodeArenaMetadata)) },
        latestLedger: 1,
      };
    },
  } as unknown as rpc.Server;
}

/** In-memory fake Prisma pre-seeded with the "already confirmed via the
 * primary POST /api/arenas path" arena, so the test can assert the backfill
 * never touches it while discovering the genuinely missed one. */
function fakePrismaWithConfirmedArena() {
  const arenas = new Map<string, { id: string; metadata: unknown }>([
    [
      CONFIRMED_ARENA_ID,
      {
        id: CONFIRMED_ARENA_ID,
        metadata: {
          name: "Already Confirmed Arena",
          createdBy: "GABCDEF...",
          contractAddress: CONFIRMED_ARENA_ID,
          deployment: { status: "confirmed", txHash: "a".repeat(64), factoryContractId: FACTORY_ID },
        },
      },
    ],
  ]);
  const cursors = new Map<string, { id: string; lastProcessed: number }>();

  const prisma = {
    arena: {
      upsert: async (args: {
        where: { id: string };
        create: { id: string; metadata: unknown };
        update: Record<string, unknown>;
      }) => {
        const existing = arenas.get(args.where.id);
        if (existing) return existing; // no-op update — never overwrite
        const created = { id: args.create.id, metadata: args.create.metadata };
        arenas.set(args.create.id, created);
        return created;
      },
    },
    backfillCursor: {
      findUnique: async (args: { where: { id: string } }) => cursors.get(args.where.id) ?? null,
      upsert: async (args: {
        where: { id: string };
        create: { id: string; lastProcessed: number };
        update: { lastProcessed: number };
      }) => {
        const row = { id: args.where.id, lastProcessed: args.create.lastProcessed };
        cursors.set(args.where.id, row);
        return row;
      },
    },
  };

  return { prisma, arenas, cursors };
}

test.afterEach(() => {
  setRpcServerForTest(null);
});

test("integration: backfill discovers a missed arena via the real factory read path, without duplicating the already-confirmed one", async () => {
  setRpcServerForTest(stubFactoryServer());
  const { prisma, arenas, cursors } = fakePrismaWithConfirmedArena();

  assert.strictEqual(arenas.size, 1, "sanity: only the confirmed arena exists before backfill runs");

  const worker = new ArenaBackfillWorker(prisma as never, FACTORY_ID);
  const result = await worker.run();

  assert.strictEqual(result.status, "success");
  assert.strictEqual(result.discovered, 2, "both on-chain pools are processed (1 no-op, 1 new)");
  assert.strictEqual(result.failed, 0);
  assert.strictEqual(result.cursor, 2);

  assert.strictEqual(arenas.size, 2, "exactly one new row (the missed arena) was added — no duplicates");
  assert.ok(arenas.has(MISSED_ARENA_ID), "the missed arena must now be discoverable");

  const confirmed = arenas.get(CONFIRMED_ARENA_ID)!;
  assert.strictEqual(
    (confirmed.metadata as { deployment: { status: string } }).deployment.status,
    "confirmed",
    "the pre-existing confirm-path row must be untouched by the backfill",
  );

  const missed = arenas.get(MISSED_ARENA_ID)!;
  assert.strictEqual(
    (missed.metadata as { deployment: { status: string } }).deployment.status,
    "backfilled",
    "the newly discovered row is marked as backfilled, distinguishing it from a confirm-path row",
  );

  assert.strictEqual(cursors.get(ARENA_DISCOVERY_CURSOR_ID)?.lastProcessed, 2);
});

test("integration: re-running the backfill after the gap is filled is a true no-op (idempotent across runs)", async () => {
  setRpcServerForTest(stubFactoryServer());
  const { prisma, arenas } = fakePrismaWithConfirmedArena();
  const worker = new ArenaBackfillWorker(prisma as never, FACTORY_ID);

  await worker.run();
  assert.strictEqual(arenas.size, 2);

  // Re-run — the factory still reports the same two pools (get_arenas is a
  // state snapshot, not an event log, so nothing is "consumed").
  const second = await worker.run();

  assert.strictEqual(second.status, "success");
  assert.strictEqual(arenas.size, 2, "no duplicate rows after a second run");
  assert.strictEqual(second.cursor, 2);
});
