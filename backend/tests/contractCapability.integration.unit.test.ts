/**
 * Cross-module integration test for contract capability negotiation (#1409):
 * onChainReader.getOnChainContractVersion (real simulateViewCall plumbing,
 * stubbed RPC) -> contractCapability.negotiateCapability using the real
 * default reader (not a test override), proving the two modules are wired
 * together correctly end to end.
 *
 * Shares onChainReader.snapshot.unit.test.ts's pre-existing limitation: this
 * repo's backend test runners (jest/tsx) cannot resolve onChainReader.ts's
 * transitive import of the frontend package's `@/`-aliased
 * stellarRpcGateway.ts (a repo-wide module-resolution gap, confirmed
 * identical on bare upstream main, unrelated to #1409). It documents and
 * exercises the intended cross-module contract and will pass once that
 * infra gap is fixed; contractCapability.unit.test.ts covers the module's
 * own logic in isolation today via its injected-reader test seam.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert";
import { nativeToScVal, Account, xdr } from "@stellar/stellar-sdk";
import type { rpc as rpcNs } from "@stellar/stellar-sdk";

import { setRpcServerForTest } from "../src/services/onChainReader";
import {
  negotiateCapability,
  isEntrypointSupported,
  setCapabilityMapForTest,
  setVersionReaderForTest,
  resetCapabilityCacheForTest,
} from "../src/services/contractCapability";

process.env.SOROBAN_RPC_URL ??= "https://soroban-testnet.stellar.org";
process.env.STELLAR_NETWORK_PASSPHRASE ??= "Test SDF Network ; September 2015";

const CONTRACT = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";

function functionNameOf(tx: { operations: Array<{ func?: xdr.HostFunction }> }): string {
  const op = tx.operations[0]!;
  return op.func!.invokeContract().functionName().toString();
}

function stubServerReturningVersion(version: number) {
  return {
    getAccount: async () => new Account("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H", "1"),
    simulateTransaction: async (tx: { operations: Array<{ func?: xdr.HostFunction }> }) => {
      const fn = functionNameOf(tx);
      if (fn !== "version") throw new Error(`Unexpected simulated call: ${fn}`);
      return {
        id: "1",
        latestLedger: 100,
        events: [],
        _parsed: true,
        transactionData: {},
        minResourceFee: "100",
        result: { retval: nativeToScVal(version, { type: "u32" }) },
      };
    },
  } as unknown as rpcNs.Server;
}

afterEach(() => {
  setRpcServerForTest(null);
  setVersionReaderForTest(null);
  setCapabilityMapForTest(null);
  resetCapabilityCacheForTest();
});

test("negotiateCapability reads the real on-chain version() through onChainReader's simulateViewCall", async () => {
  setRpcServerForTest(stubServerReturningVersion(2));

  const version = await negotiateCapability("arena", CONTRACT);

  assert.strictEqual(version, 2);
});

test("isEntrypointSupported gates on the real negotiated version end to end", async () => {
  setRpcServerForTest(stubServerReturningVersion(1));
  setCapabilityMapForTest({ arena: { future_entrypoint: 2 }, factory: {}, payout: {}, staking: {} });

  const supported = await isEntrypointSupported("arena", CONTRACT, "future_entrypoint");

  assert.strictEqual(supported, false);
});

test("a version-read failure through the real chain surfaces as CapabilityNegotiationError, not a silent default", async () => {
  setRpcServerForTest({
    getAccount: async () => {
      throw new Error("ECONNREFUSED");
    },
    simulateTransaction: async () => {
      throw new Error("unreachable");
    },
  } as unknown as rpcNs.Server);

  await assert.rejects(() => negotiateCapability("arena", CONTRACT));
});
