/**
 * Unit tests for getOnChainSnapshotOrThrow (#1408) — the all-or-nothing
 * on-chain read that arenaStatsService's degraded-mode fallback is built on.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert";
import {
  Account,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import type { rpc as rpcNs } from "@stellar/stellar-sdk";

import {
  getOnChainSnapshotOrThrow,
  setRpcServerForTest,
} from "../src/services/onChainReader";

process.env.SOROBAN_RPC_URL ??= "https://soroban-testnet.stellar.org";
process.env.STELLAR_NETWORK_PASSPHRASE ??= "Test SDF Network ; September 2015";

const CONTRACT = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const VAULT = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";

function functionNameOf(tx: { operations: Array<{ func?: xdr.HostFunction }> }): string {
  const op = tx.operations[0]!;
  return op.func!.invokeContract().functionName().toString();
}

function successResult(retval: xdr.ScVal) {
  return {
    id: "1",
    latestLedger: 100,
    events: [],
    _parsed: true,
    transactionData: {},
    minResourceFee: "100",
    result: { retval },
  };
}

function stubServer(handlers: Record<string, () => xdr.ScVal>) {
  return {
    getAccount: async () => new Account("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H", "1"),
    simulateTransaction: async (tx: { operations: Array<{ func?: xdr.HostFunction }> }) => {
      const fn = functionNameOf(tx);
      const handler = handlers[fn];
      if (!handler) throw new Error(`Unexpected simulated call: ${fn}`);
      return successResult(handler());
    },
  } as unknown as rpcNs.Server;
}

afterEach(() => {
  setRpcServerForTest(null);
});

test("getOnChainSnapshotOrThrow: returns playerCount, gameState, and yieldAccrued together on success", async () => {
  setRpcServerForTest(
    stubServer({
      get_player_count: () => nativeToScVal(12, { type: "u32" }),
      game_state: () => nativeToScVal("InProgress", { type: "symbol" }),
      get_total_yield: () => nativeToScVal(500, { type: "i128" }),
    }),
  );

  const snapshot = await getOnChainSnapshotOrThrow(CONTRACT, VAULT);

  assert.strictEqual(snapshot.playerCount, 12);
  assert.strictEqual(snapshot.gameState, "InProgress");
  assert.strictEqual(snapshot.yieldAccrued, 500);
});

test("getOnChainSnapshotOrThrow: throws (does not default) when any one of the three calls fails", async () => {
  setRpcServerForTest({
    getAccount: async () => new Account("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H", "1"),
    simulateTransaction: async (tx: { operations: Array<{ func?: xdr.HostFunction }> }) => {
      const fn = functionNameOf(tx);
      if (fn === "game_state") {
        throw new Error("simulation timeout");
      }
      return successResult(nativeToScVal(1, { type: "u32" }));
    },
  } as unknown as rpcNs.Server);

  await assert.rejects(() => getOnChainSnapshotOrThrow(CONTRACT, VAULT));
});

test("getOnChainSnapshotOrThrow: throws when the RPC server itself is unreachable", async () => {
  setRpcServerForTest({
    getAccount: async () => {
      throw new Error("ECONNREFUSED");
    },
    simulateTransaction: async () => {
      throw new Error("unreachable");
    },
  } as unknown as rpcNs.Server);

  await assert.rejects(() => getOnChainSnapshotOrThrow(CONTRACT, VAULT), /ECONNREFUSED/);
});
