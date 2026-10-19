import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  getCurrentLedgerSequence,
  setRpcServerForTest,
  resetLedgerClockCacheForTest,
} from "../src/services/ledgerClock";
import { CircuitBreaker } from "../src/utils/circuitBreaker";
import * as ledgerClock from "../src/services/ledgerClock";

function fakeServer(sequence: number) {
  let calls = 0;
  return {
    server: {
      getLatestLedger: async () => {
        calls++;
        return { id: "abc", sequence, protocolVersion: 22 };
      },
    },
    getCalls: () => calls,
  };
}

// A breaker with a generous threshold so these tests exercise caching, not
// circuit-open behavior.
function freshBreaker() {
  return new CircuitBreaker({
    timeout: 1000,
    errorThresholdPercentage: 100,
    resetTimeout: 100,
    volumeThreshold: 1000,
  });
}

beforeEach(() => {
  resetLedgerClockCacheForTest();
  ledgerClock.setCircuitBreakerForTest(freshBreaker());
});

afterEach(() => {
  setRpcServerForTest(null);
  ledgerClock.setCircuitBreakerForTest(null);
});

test("getCurrentLedgerSequence returns the ledger sequence from the RPC server", async () => {
  const { server } = fakeServer(12345);
  setRpcServerForTest(server as never);

  const sequence = await getCurrentLedgerSequence();

  assert.strictEqual(sequence, 12345);
});

test("getCurrentLedgerSequence caches the result and does not re-fetch within the TTL window", async () => {
  const { server, getCalls } = fakeServer(100);
  setRpcServerForTest(server as never);

  await getCurrentLedgerSequence();
  await getCurrentLedgerSequence();
  await getCurrentLedgerSequence();

  assert.strictEqual(getCalls(), 1, "a second/third call within the TTL must not hit the RPC server again");
});

test("resetLedgerClockCacheForTest forces a fresh fetch", async () => {
  const { server, getCalls } = fakeServer(200);
  setRpcServerForTest(server as never);

  await getCurrentLedgerSequence();
  resetLedgerClockCacheForTest();
  await getCurrentLedgerSequence();

  assert.strictEqual(getCalls(), 2);
});

test("getCurrentLedgerSequence propagates RPC failures", async () => {
  setRpcServerForTest({
    getLatestLedger: async () => {
      throw new Error("RPC unavailable");
    },
  } as never);

  await assert.rejects(() => getCurrentLedgerSequence(), /RPC unavailable/);
});
