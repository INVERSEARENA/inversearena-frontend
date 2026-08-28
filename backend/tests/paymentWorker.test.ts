import { describe, it } from "node:test";
import assert from "node:assert";
import { PaymentWorker } from "../src/workers/paymentWorker";

describe("PaymentWorker concurrency & execution", () => {
  it("prevents concurrent execution when processBatch is called while running", async () => {
    let resolveFirstBatch: () => void;
    const firstBatchPromise = new Promise<void>((resolve) => {
      resolveFirstBatch = resolve;
    });

    let listCount = 0;
    const mockTransactions = {
      listByStatus: async () => {
        listCount++;
        await firstBatchPromise;
        return [];
      },
      updateStatus: async () => {},
    };

    const mockPaymentService = {
      processPayout: async () => {},
    };

    const worker = new PaymentWorker(
      mockTransactions as any,
      mockPaymentService as any
    );

    const firstRunPromise = worker.processBatch();

    // Verify lock is active while first run is awaiting listByStatus
    assert.strictEqual((worker as any).isRunning, true);

    // Call processBatch second time while first run is in progress
    const secondRunResult = await worker.processBatch();

    // Second call should have returned processed: 0 immediately
    assert.strictEqual(secondRunResult.processed, 0);
    assert.strictEqual(listCount, 1);

    // Resolve first run
    resolveFirstBatch!();
    await firstRunPromise;

    assert.strictEqual((worker as any).isRunning, false);
  });

  it("allows sequential processBatch runs after completion", async () => {
    let listCount = 0;
    const mockTransactions = {
      listByStatus: async () => {
        listCount++;
        return [];
      },
      updateStatus: async () => {},
    };

    const mockPaymentService = {
      processPayout: async () => {},
    };

    const worker = new PaymentWorker(
      mockTransactions as any,
      mockPaymentService as any
    );

    await worker.processBatch();
    assert.strictEqual(listCount, 1);

    await worker.processBatch();
    assert.strictEqual(listCount, 2);
    assert.strictEqual((worker as any).isRunning, false);
  });
});
