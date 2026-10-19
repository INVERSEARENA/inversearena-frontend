/**
 * Unit tests for `getFactoryArenaPage` / `decodeArenaMetadata` (#1391).
 *
 * These build ScVal fixtures the same way soroban-sdk's #[contracttype]
 * derive actually encodes `ArenaMetadata`/`ArenaStatus`
 * (contract/factory/src/types.rs) — verified empirically against a real
 * `cargo test` dump of the contract's own encoding, not guessed. In
 * particular: `ArenaStatus` is a fieldless Rust enum, which encodes as a
 * one-element `ScVec` containing the variant's `Symbol` (`Vec([Symbol("Active")])`),
 * not a bare Symbol/string — this is the bug `decodeArenaMetadata` had to be
 * fixed to handle (see onChainReader.ts).
 */
import { test } from "node:test";
import assert from "node:assert";
import { Address, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";

import {
  getFactoryArenaPage,
  FactoryReadError,
  setRpcServerForTest,
} from "../src/services/onChainReader";

process.env.SOROBAN_RPC_URL ??= "https://soroban-testnet.stellar.org";
process.env.STELLAR_NETWORK_PASSPHRASE ??= "Test SDF Network ; September 2015";

const FACTORY_ID = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const ARENA_ID_1 = "CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3";
const ARENA_ID_2 = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";
const HOST = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

interface ArenaFixtureInput {
  arena_address: string;
  pool_id: number;
  host: string;
  entry_fee: bigint;
  status: "Pending" | "Active" | "Finished" | "Cancelled";
  created_at: number;
}

/** Encodes one ArenaMetadata entry exactly as soroban-sdk's #[contracttype]
 * derive does: an ScMap keyed by field name (alphabetical), with the
 * fieldless ArenaStatus enum as a one-element ScVec of its variant Symbol. */
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

function encodePage(arenas: ArenaFixtureInput[]): xdr.ScVal {
  return xdr.ScVal.scvVec(arenas.map(encodeArenaMetadata));
}

function stubServerReturning(retval: xdr.ScVal): rpc.Server {
  return {
    getAccount: async () => ({
      accountId: () => HOST,
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    }),
    simulateTransaction: async () => ({
      transactionData: {},
      result: { retval },
      latestLedger: 1,
    }),
  } as unknown as rpc.Server;
}

function stubServerThrowing(err: Error): rpc.Server {
  return {
    getAccount: async () => {
      throw err;
    },
  } as unknown as rpc.Server;
}

function stubServerSimulationError(message: string): rpc.Server {
  return {
    getAccount: async () => ({
      accountId: () => HOST,
      sequenceNumber: () => "1",
      incrementSequenceNumber: () => {},
    }),
    simulateTransaction: async () => ({
      error: message,
    }),
  } as unknown as rpc.Server;
}

test.afterEach(() => {
  setRpcServerForTest(null);
});

test("getFactoryArenaPage: normal path decodes a full page correctly", async () => {
  const fixtures: ArenaFixtureInput[] = [
    {
      arena_address: ARENA_ID_1,
      pool_id: 1,
      host: HOST,
      entry_fee: 500n,
      status: "Active",
      created_at: 1_700_000_000,
    },
    {
      arena_address: ARENA_ID_2,
      pool_id: 2,
      host: HOST,
      entry_fee: 1_000n,
      status: "Pending",
      created_at: 1_700_000_100,
    },
  ];
  setRpcServerForTest(stubServerReturning(encodePage(fixtures)));

  const result = await getFactoryArenaPage(FACTORY_ID, 0, 50);

  assert.strictEqual(result.length, 2);
  assert.deepStrictEqual(result[0], {
    arenaAddress: ARENA_ID_1,
    poolId: 1,
    host: HOST,
    entryFee: 500n,
    status: "Active",
    createdAt: 1_700_000_000,
  });
  assert.strictEqual(result[1]!.status, "Pending");
});

test("getFactoryArenaPage: boundary — empty page (end of list) decodes to an empty array", async () => {
  setRpcServerForTest(stubServerReturning(encodePage([])));

  const result = await getFactoryArenaPage(FACTORY_ID, 1000, 50);

  assert.deepStrictEqual(result, []);
});

test("getFactoryArenaPage: boundary — all four ArenaStatus variants decode correctly", async () => {
  const statuses: Array<ArenaFixtureInput["status"]> = [
    "Pending",
    "Active",
    "Finished",
    "Cancelled",
  ];
  const fixtures = statuses.map((status, i) => ({
    arena_address: i % 2 === 0 ? ARENA_ID_1 : ARENA_ID_2,
    pool_id: i + 1,
    host: HOST,
    entry_fee: BigInt(i),
    status,
    created_at: 1_700_000_000 + i,
  }));
  setRpcServerForTest(stubServerReturning(encodePage(fixtures)));

  const result = await getFactoryArenaPage(FACTORY_ID, 0, 50);

  assert.deepStrictEqual(
    result.map((r) => r.status),
    statuses,
  );
});

test("getFactoryArenaPage: retry-relevant — RPC/network failure throws FactoryReadError, not an empty page", async () => {
  setRpcServerForTest(stubServerThrowing(new Error("ECONNRESET")));

  await assert.rejects(
    () => getFactoryArenaPage(FACTORY_ID, 0, 50),
    (err: unknown) => {
      assert.ok(err instanceof FactoryReadError);
      assert.match((err as Error).message, /simulation failed/);
      return true;
    },
  );
});

test("getFactoryArenaPage: retry-relevant — Soroban simulation error throws FactoryReadError", async () => {
  setRpcServerForTest(stubServerSimulationError("host invocation failed"));

  await assert.rejects(
    () => getFactoryArenaPage(FACTORY_ID, 0, 50),
    (err: unknown) => {
      assert.ok(err instanceof FactoryReadError);
      return true;
    },
  );
});

test("getFactoryArenaPage: invalid input — malformed arena_address is rejected without silently dropping the record", async () => {
  const entries = [
    new xdr.ScMapEntry({
      key: nativeToScVal("arena_address", { type: "symbol" }),
      val: nativeToScVal("not-a-contract-id", { type: "string" }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("created_at", { type: "symbol" }),
      val: nativeToScVal(1, { type: "u64" }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("entry_fee", { type: "symbol" }),
      val: nativeToScVal(1n, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("host", { type: "symbol" }),
      val: new Address(HOST).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("pool_id", { type: "symbol" }),
      val: nativeToScVal(1, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("status", { type: "symbol" }),
      val: xdr.ScVal.scvVec([nativeToScVal("Active", { type: "symbol" })]),
    }),
  ];
  const malformed = xdr.ScVal.scvVec([xdr.ScVal.scvMap(entries)]);
  setRpcServerForTest(stubServerReturning(malformed));

  await assert.rejects(
    () => getFactoryArenaPage(FACTORY_ID, 0, 50),
    (err: unknown) => {
      assert.ok(err instanceof FactoryReadError);
      assert.match((err as Error).message, /not a valid Soroban contract id/);
      return true;
    },
  );
});

test("getFactoryArenaPage: invalid input — unrecognized status is rejected", async () => {
  const fixture: ArenaFixtureInput = {
    arena_address: ARENA_ID_1,
    pool_id: 1,
    host: HOST,
    entry_fee: 1n,
    status: "Active",
    created_at: 1,
  };
  const entry = encodeArenaMetadata(fixture);
  // Overwrite the status entry with an unrecognized variant.
  const mapEntries = entry.map()!.map((e) => {
    if (e.key().sym().toString() === "status") {
      return new xdr.ScMapEntry({
        key: e.key(),
        val: xdr.ScVal.scvVec([nativeToScVal("Exploded", { type: "symbol" })]),
      });
    }
    return e;
  });
  const malformed = xdr.ScVal.scvVec([xdr.ScVal.scvMap(mapEntries)]);
  setRpcServerForTest(stubServerReturning(malformed));

  await assert.rejects(
    () => getFactoryArenaPage(FACTORY_ID, 0, 50),
    (err: unknown) => {
      assert.ok(err instanceof FactoryReadError);
      assert.match((err as Error).message, /not a recognized ArenaStatus/);
      return true;
    },
  );
});

test("getFactoryArenaPage: invalid input — non-array retval is rejected", async () => {
  setRpcServerForTest(stubServerReturning(nativeToScVal(42, { type: "u32" })));

  await assert.rejects(
    () => getFactoryArenaPage(FACTORY_ID, 0, 50),
    (err: unknown) => {
      assert.ok(err instanceof FactoryReadError);
      assert.match((err as Error).message, /non-array result/);
      return true;
    },
  );
});
