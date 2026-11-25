import { describe, it, expect, afterEach } from "@jest/globals";
import { xdr } from "@stellar/stellar-sdk";
import {
  XdrDecodePool,
  PoolSaturationError,
  XdrDecodeError,
  serializeBigIntForClone,
  deserializeBigIntFromClone,
  closeSharedXdrDecodePool,
} from "../../src/services/xdrDecodePool";
import {
  startEventLoopMonitoring,
  stopEventLoopMonitoring,
  eventLoopLagSeconds,
} from "../../src/metrics/domains/ops.metrics";

describe("XdrDecodePool (#1834)", () => {
  let pool: XdrDecodePool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.drain();
      pool = null;
    }
    await closeSharedXdrDecodePool();
    stopEventLoopMonitoring();
  });

  describe("Structured-Clone Safe BigInt Serialization", () => {
    it("round-trips primitive BigInt and nested objects without precision loss", () => {
      const original = {
        amount: 9223372036854775807000111222n,
        nested: {
          subAmount: 123456789012345678901234567890n,
          list: [1n, 2n, "hello", 42],
        },
      };

      const serialized = serializeBigIntForClone(original);
      expect(typeof (serialized as any).amount).toBe("object");
      expect((serialized as any).amount.__isBigInt).toBe(true);

      const restored = deserializeBigIntFromClone(serialized) as typeof original;
      expect(restored.amount).toBe(9223372036854775807000111222n);
      expect(restored.nested.subAmount).toBe(123456789012345678901234567890n);
      expect(restored.nested.list[0]).toBe(1n);
      expect(restored.nested.list[2]).toBe("hello");
    });
  });

  describe("Adaptive Threshold & Inline Decoding", () => {
    it("decodes small batches inline when below batchThreshold", async () => {
      pool = new XdrDecodePool({ threadCount: 2, batchThreshold: 5 });

      // Create 2 ScVal base64 strings (u32: 100, u32: 200)
      const xdr1 = xdr.ScVal.scvU32(100).toXDR("base64");
      const xdr2 = xdr.ScVal.scvU32(200).toXDR("base64");

      const results = await pool.decodeScVals([xdr1, xdr2]);
      expect(results).toEqual([100, 200]);
    });

    it("offloads to worker pool when batch size meets or exceeds batchThreshold", async () => {
      pool = new XdrDecodePool({ threadCount: 2, batchThreshold: 3 });

      const items = [10, 20, 30, 40].map((n) => xdr.ScVal.scvU32(n).toXDR("base64"));
      const results = await pool.decodeScVals(items);
      expect(results).toEqual([10, 20, 30, 40]);
    });
  });

  describe("Ledger Entry Batch Decoding", () => {
    function makeSampleContractDataEntry(valU32: number): string {
      const entry = xdr.LedgerEntryData.contractData(
        new xdr.ContractDataEntry({
          ext: new xdr.ExtensionPoint(0),
          contract: new xdr.ScAddress(xdr.ScAddressType.scAddressTypeContract(), Buffer.alloc(32)),
          key: xdr.ScVal.scvSymbol("round"),
          durability: xdr.ContractDataDurability.persistent(),
          val: xdr.ScVal.scvU32(valU32),
        }),
      );
      return entry.toXDR("base64");
    }

    it("decodes contract data ledger entries accurately in worker thread", async () => {
      pool = new XdrDecodePool({ threadCount: 2, batchThreshold: 1 });

      const base64 = makeSampleContractDataEntry(7);
      const decoded = await pool.decodeLedgerEntries([
        { name: "round_num", xdr: base64, liveUntil: 1000 },
      ], 500);

      expect(decoded.round_num).toBe(7);
    });

    it("propagates archived entry restore error", async () => {
      pool = new XdrDecodePool({ threadCount: 1, batchThreshold: 1 });

      const base64 = makeSampleContractDataEntry(7);
      // liveUntil (500) < nowLedger (600) -> should fail
      await expect(
        pool.decodeLedgerEntries([{ name: "archived", xdr: base64, liveUntil: 500 }], 600),
      ).rejects.toThrow("archived and needs a restore");
    });

    it("propagates decode errors on malformed XDR data", async () => {
      pool = new XdrDecodePool({ threadCount: 1, batchThreshold: 1 });

      await expect(
        pool.decodeScVals(["not-valid-base64-xdr-at-all"])
      ).rejects.toThrow();
    });
  });

  describe("Queue Saturation & Backpressure", () => {
    it("throws PoolSaturationError when task queue limit is exceeded", async () => {
      pool = new XdrDecodePool({ threadCount: 1, maxQueueSize: 2, batchThreshold: 1 });

      // Build a slow payload
      const scValXdr = xdr.ScVal.scvU32(1).toXDR("base64");

      // Flood the pool with tasks beyond maxQueueSize
      const p1 = pool.decodeScVals([scValXdr]);
      const p2 = pool.decodeScVals([scValXdr]);
      const p3 = pool.decodeScVals([scValXdr]);

      // p4 should saturate the queue (thread=1 active, queue size limit=2)
      await expect(pool.decodeScVals([scValXdr])).rejects.toThrow(PoolSaturationError);

      await Promise.allSettled([p1, p2, p3]);
    });
  });

  describe("Graceful Shutdown & Drain", () => {
    it("drains active tasks cleanly and rejects subsequent submissions", async () => {
      pool = new XdrDecodePool({ threadCount: 2, batchThreshold: 1 });
      const scValXdr = xdr.ScVal.scvU32(99).toXDR("base64");

      const task = pool.decodeScVals([scValXdr]);
      await pool.drain();

      const result = await task;
      expect(result).toEqual([99]);

      // Submissions after drain should be refused
      await expect(pool.decodeScVals([scValXdr])).rejects.toThrow(
        "refusing new tasks",
      );
    });
  });

  describe("Event-Loop Lag Metric Export", () => {
    it("starts monitoring and observes event-loop lag metric", async () => {
      const monitor = startEventLoopMonitoring(20, 50);
      expect(monitor).toBeDefined();

      // Induce slight event loop spin
      const start = Date.now();
      while (Date.now() - start < 60) {}

      await new Promise((r) => setTimeout(r, 120));
      stopEventLoopMonitoring();

      const metric = await eventLoopLagSeconds.get();
      expect(metric).toBeDefined();
      expect(metric.name).toBe("inversearena_event_loop_lag_seconds");
    });
  });
});
