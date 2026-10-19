/**
 * Tests for the deterministic fault-injection helpers (#1461): timeout,
 * stale response, duplicate delivery, and partial outage across RPC, Redis,
 * and queue targets, plus a cross-module flow through onChainReader.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert";
import { Account, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type Redis from "ioredis";

import {
  getOnChainContractVersion,
  getOnChainSnapshotOrThrow,
  setRpcServerForTest,
  type OnChainRpcServer,
} from "../src/services/onChainReader";
import {
  FaultConfigError,
  FaultInjector,
  FaultQueueDelivery,
  InjectedOutageError,
  InjectedTimeoutError,
  createFaultyRedis,
  createFaultyRpcServer,
} from "./helpers/faultInjection";

process.env.SOROBAN_RPC_URL ??= "https://soroban-testnet.stellar.org";
process.env.STELLAR_NETWORK_PASSPHRASE ??= "Test SDF Network ; September 2015";

const CONTRACT = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const VAULT = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";
const SOURCE = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

function functionNameOf(tx: { operations: Array<{ func?: xdr.HostFunction }> }): string {
  return tx.operations[0]!.func!.invokeContract().functionName().toString();
}

function stubRpc(handlers: Record<string, () => xdr.ScVal>): OnChainRpcServer {
  return {
    getAccount: async () => new Account(SOURCE, "1"),
    simulateTransaction: (async (tx: { operations: Array<{ func?: xdr.HostFunction }> }) => {
      const fn = functionNameOf(tx);
      const handler = handlers[fn];
      if (!handler) throw new Error(`Unexpected simulated call: ${fn}`);
      return {
        id: "1",
        latestLedger: 100,
        events: [],
        _parsed: true,
        transactionData: {},
        minResourceFee: "100",
        result: { retval: handler() },
      };
    }) as unknown as OnChainRpcServer["simulateTransaction"],
  };
}

class MemoryRedis {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<"OK"> {
    this.values.set(key, value);
    return "OK";
  }
  async incr(key: string): Promise<number> {
    const next = Number(this.values.get(key) ?? "0") + 1;
    this.values.set(key, String(next));
    return next;
  }
  on(): this {
    return this;
  }
}

afterEach(() => {
  setRpcServerForTest(null);
});

// ---------------------------------------------------------------------------
// FaultInjector core
// ---------------------------------------------------------------------------

test("FaultInjector: no rules passes every call through and records success", async () => {
  const injector = new FaultInjector();
  const value = await injector.run("rpc", "op", null, async () => 42);
  assert.strictEqual(value, 42);
  assert.deepStrictEqual(
    { calls: injector.stats().calls, success: injector.stats().success },
    { calls: 1, success: 1 },
  );
});

test("FaultInjector: onCalls fires only on the listed call indices (boundary)", async () => {
  const injector = new FaultInjector([{ target: "rpc", kind: "timeout", onCalls: [2] }]);
  const exec = async () => "ok";
  assert.strictEqual(await injector.run("rpc", "op", null, exec), "ok");
  await assert.rejects(() => injector.run("rpc", "op", null, exec), InjectedTimeoutError);
  assert.strictEqual(await injector.run("rpc", "op", null, exec), "ok");
});

test("FaultInjector: times caps how often a rule fires", async () => {
  const injector = new FaultInjector([{ target: "redis", kind: "outage", times: 2 }]);
  const exec = async () => "ok";
  await assert.rejects(() => injector.run("redis", "get", "k", exec), InjectedOutageError);
  await assert.rejects(() => injector.run("redis", "get", "k", exec), InjectedOutageError);
  assert.strictEqual(await injector.run("redis", "get", "k", exec), "ok");
});

test("FaultInjector: same rules and call sequence produce identical fault events", async () => {
  const rules = [
    { target: "rpc" as const, kind: "timeout" as const, onCalls: [1, 3] },
    { target: "rpc" as const, kind: "duplicate" as const, onCalls: [2] },
  ];
  const trace = async () => {
    const injector = new FaultInjector(rules, { now: () => 0 });
    for (let i = 0; i < 4; i += 1) {
      await injector.run("rpc", "op", null, async () => i).catch(() => undefined);
    }
    return injector.events;
  };
  assert.deepStrictEqual(await trace(), await trace());
});

test("FaultInjector: stale without a prior result is a configuration error", async () => {
  const injector = new FaultInjector([{ target: "rpc", kind: "stale" }]);
  await assert.rejects(() => injector.run("rpc", "op", null, async () => 1), FaultConfigError);
});

test("FaultInjector: invalid rules are rejected at construction", () => {
  assert.throws(
    () => new FaultInjector([{ target: "rpc", kind: "explode" as never }]),
    FaultConfigError,
  );
  assert.throws(() => new FaultInjector([{ target: "nope" as never, kind: "timeout" }]), FaultConfigError);
  assert.throws(() => new FaultInjector([{ target: "rpc", kind: "timeout", times: 0 }]), FaultConfigError);
  assert.throws(() => new FaultInjector([{ target: "rpc", kind: "timeout", onCalls: [0] }]), FaultConfigError);
});

test("FaultInjector: stats expose success, failure, retry, and latency", async () => {
  let clock = 0;
  const injector = new FaultInjector([{ target: "queue", kind: "outage", onCalls: [1] }], {
    now: () => (clock += 5),
  });
  await injector.run("queue", "job", "1", async () => 1).catch(() => undefined);
  await injector.run("queue", "job", "1", async () => 1, true);
  const stats = injector.stats("queue");
  assert.strictEqual(stats.calls, 2);
  assert.strictEqual(stats.success, 1);
  assert.strictEqual(stats.failure, 1);
  assert.strictEqual(stats.retries, 1);
  assert.strictEqual(stats.faults.outage, 1);
  assert.strictEqual(stats.totalLatencyMs, 10);
});

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

test("createFaultyRedis: partial outage only affects keys under the prefix", async () => {
  const base = new MemoryRedis();
  const injector = new FaultInjector([{ target: "redis", kind: "outage", key: "lobby:" }]);
  const redis = createFaultyRedis(base as unknown as Redis, injector);

  assert.strictEqual(await redis.set("session:1", "a"), "OK");
  await assert.rejects(() => redis.set("lobby:1", "b"), InjectedOutageError);
  assert.strictEqual(await redis.get("session:1"), "a");
  assert.strictEqual(base.values.has("lobby:1"), false);
});

test("createFaultyRedis: stale read returns the previously observed value", async () => {
  const base = new MemoryRedis();
  const injector = new FaultInjector([{ target: "redis", kind: "stale", operation: "get", onCalls: [2] }]);
  const redis = createFaultyRedis(base as unknown as Redis, injector);

  await redis.set("k", "v1");
  assert.strictEqual(await redis.get("k"), "v1");
  await redis.set("k", "v2");
  assert.strictEqual(await redis.get("k"), "v1");
  assert.strictEqual(await redis.get("k"), "v2");
});

test("createFaultyRedis: duplicate executes the command twice", async () => {
  const base = new MemoryRedis();
  const injector = new FaultInjector([{ target: "redis", kind: "duplicate", operation: "incr" }]);
  const redis = createFaultyRedis(base as unknown as Redis, injector);

  assert.strictEqual(await redis.incr("counter"), 2);
  assert.strictEqual(base.values.get("counter"), "2");
});

test("createFaultyRedis: event plumbing passes through untouched", () => {
  const base = new MemoryRedis();
  const injector = new FaultInjector([{ target: "redis", kind: "outage" }]);
  const redis = createFaultyRedis(base as unknown as Redis, injector);
  assert.strictEqual(redis.on("error", () => undefined), base);
  assert.strictEqual(injector.events.length, 0);
});

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

test("FaultQueueDelivery: duplicate delivery invokes the processor twice for one job", async () => {
  const seen: string[] = [];
  const injector = new FaultInjector([{ target: "queue", kind: "duplicate", onCalls: [1] }]);
  const delivery = new FaultQueueDelivery(async (job: { id: string }) => {
    seen.push(job.id);
    return seen.length;
  }, injector);

  const result = await delivery.deliver({ id: "tx-1", name: "confirm", data: {} });
  assert.strictEqual(result.status, "completed");
  assert.deepStrictEqual(seen, ["tx-1", "tx-1"]);
});

test("FaultQueueDelivery: retries after a timeout and completes", async () => {
  const injector = new FaultInjector([{ target: "queue", kind: "timeout", onCalls: [1] }]);
  const delivery = new FaultQueueDelivery(async (job) => job.attemptsMade, injector, { attempts: 3 });

  const result = await delivery.deliver({ id: "tx-1", name: "confirm", data: {} });
  assert.deepStrictEqual(result, { status: "completed", attemptsMade: 2, result: 1 });
  assert.strictEqual(injector.stats("queue").retries, 1);
});

test("FaultQueueDelivery: exhausting attempts reports failure with the last error", async () => {
  const injector = new FaultInjector([{ target: "queue", kind: "outage" }]);
  const delivery = new FaultQueueDelivery(async () => "never", injector, { attempts: 2 });

  const result = await delivery.deliver({ id: "tx-1", name: "confirm", data: {} });
  assert.strictEqual(result.status, "failed");
  assert.strictEqual(result.attemptsMade, 2);
  assert.ok(result.error instanceof InjectedOutageError);
});

test("FaultQueueDelivery: rejects invalid attempts and job ids", async () => {
  const injector = new FaultInjector();
  assert.throws(() => new FaultQueueDelivery(async () => 1, injector, { attempts: 0 }), FaultConfigError);
  const delivery = new FaultQueueDelivery(async () => 1, injector);
  await assert.rejects(() => delivery.deliver({ id: "", name: "confirm", data: {} }), FaultConfigError);
});

// ---------------------------------------------------------------------------
// RPC + onChainReader (cross-module)
// ---------------------------------------------------------------------------

test("integration: RPC timeout on one view call surfaces as a snapshot read failure", async () => {
  const injector = new FaultInjector([
    { target: "rpc", kind: "timeout", operation: "simulateTransaction", key: "game_state" },
  ]);
  setRpcServerForTest(
    createFaultyRpcServer(
      stubRpc({
        get_player_count: () => nativeToScVal(3, { type: "u32" }),
        game_state: () => nativeToScVal("Open", { type: "symbol" }),
        get_total_yield: () => nativeToScVal(0, { type: "i128" }),
      }),
      injector,
    ),
  );

  await assert.rejects(() => getOnChainSnapshotOrThrow(CONTRACT, VAULT), /Injected timeout/);
  assert.strictEqual(injector.stats("rpc").faults.timeout, 1);
});

test("integration: stale RPC response replays the earlier contract version", async () => {
  let version = 1;
  const injector = new FaultInjector([
    { target: "rpc", kind: "stale", operation: "simulateTransaction", onCalls: [2] },
  ]);
  setRpcServerForTest(
    createFaultyRpcServer(stubRpc({ version: () => nativeToScVal(version, { type: "u32" }) }), injector),
  );

  assert.strictEqual(await getOnChainContractVersion(CONTRACT), 1);
  version = 2;
  assert.strictEqual(await getOnChainContractVersion(CONTRACT), 1);
  assert.strictEqual(await getOnChainContractVersion(CONTRACT), 2);
});

test("integration: partial RPC outage recovers on caller retry", async () => {
  const injector = new FaultInjector([
    { target: "rpc", kind: "outage", operation: "getAccount", times: 1 },
  ]);
  setRpcServerForTest(
    createFaultyRpcServer(stubRpc({ version: () => nativeToScVal(7, { type: "u32" }) }), injector),
  );

  await assert.rejects(() => getOnChainContractVersion(CONTRACT));
  assert.strictEqual(await getOnChainContractVersion(CONTRACT), 7);
  const stats = injector.stats("rpc");
  assert.strictEqual(stats.faults.outage, 1);
  assert.ok(stats.success >= 2);
});
