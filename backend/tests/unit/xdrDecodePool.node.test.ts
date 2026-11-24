import { describe, it, after } from "node:test";
import assert from "node:assert";
import { xdr } from "@stellar/stellar-sdk";
import {
  XdrDecodePool,
  PoolSaturationError,
  serializeBigIntForClone,
  deserializeBigIntFromClone,
} from "../../src/services/xdrDecodePool";
import {
  startEventLoopMonitoring,
  stopEventLoopMonitoring,
  eventLoopLagSeconds,
} from "../../src/metrics/domains/ops.metrics";

describe("XdrDecodePool node:test suite (#1834)", () => {
  let pool: XdrDecodePool | null = null;

  after(async () => {
    if (pool) {
      await pool.drain();
      pool = null;
    }
    stopEventLoopMonitoring();
  });

  it("handles structured-clone BigInt serialization round-trip", () => {
    const data = {
      val: 99999999999999999999999999n,
      nested: [100n, 200n],
    };
    const cloned = deserializeBigIntFromClone(serializeBigIntForClone(data)) as typeof data;
    assert.strictEqual(cloned.val, 99999999999999999999999999n);
    assert.strictEqual(cloned.nested[0], 100n);
  });

  it("decodes small batches inline below threshold", async () => {
    pool = new XdrDecodePool({ threadCount: 2, batchThreshold: 5 });
    const xdr1 = xdr.ScVal.scvU32(50).toXDR("base64");
    const results = await pool.decodeScVals([xdr1]);
    assert.deepStrictEqual(results, [50]);
    await pool.drain();
    pool = null;
  });

  it("offloads batch decoding to worker threads above threshold", async () => {
    pool = new XdrDecodePool({ threadCount: 2, batchThreshold: 2 });
    const items = [1, 2, 3, 4].map((n) => xdr.ScVal.scvU32(n).toXDR("base64"));
    const results = await pool.decodeScVals(items);
    assert.deepStrictEqual(results, [1, 2, 3, 4]);
    await pool.drain();
    pool = null;
  });

  it("throws PoolSaturationError on task queue overflow", async () => {
    pool = new XdrDecodePool({ threadCount: 1, maxQueueSize: 2, batchThreshold: 1 });
    const item = xdr.ScVal.scvU32(1).toXDR("base64");

    const p1 = pool.decodeScVals([item]);
    const p2 = pool.decodeScVals([item]);
    const p3 = pool.decodeScVals([item]);

    await assert.rejects(
      async () => {
        await pool!.decodeScVals([item]);
      },
      (err: Error) => err instanceof PoolSaturationError,
    );

    await Promise.allSettled([p1, p2, p3]);
    await pool.drain();
    pool = null;
  });

  it("monitors event-loop lag and updates histogram", async () => {
    const monitor = startEventLoopMonitoring(10, 50);
    assert.ok(monitor);

    await new Promise((r) => setTimeout(r, 100));
    stopEventLoopMonitoring();

    const metric = await eventLoopLagSeconds.get();
    assert.strictEqual(metric.name, "inversearena_event_loop_lag_seconds");
  });
});
