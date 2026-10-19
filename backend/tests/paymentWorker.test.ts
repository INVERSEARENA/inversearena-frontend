import { describe, it } from "node:test";
import assert from "node:assert";
import { PaymentWorker } from "../src/workers/paymentWorker";
import type { TransactionRecord } from "../src/types/payment";

function failedTransaction(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    id: "tx-1",
    payoutId: "payout-1",
    idempotencyKey: "key-1",
    sourceAccount: "source",
    destinationAccount: "destination",
    asset: "USDC",
    amountStroops: "100",
    nonce: 1,
    status: "failed",
    unsignedXdr: "unsigned",
    signedXdr: "signed",
    errorMessage: "submission failed",
    attempts: 1,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date(Date.now() - 60_000),
    ...overrides,
  };
}

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

  it("dead-letters a failed payout that has no signed XDR", async () => {
    const updates: Array<{ id: string; patch: Partial<TransactionRecord> }> = [];
    const transaction = failedTransaction({ signedXdr: null });
    const transactions = {
      listByStatus: async () => [transaction],
      update: async (id: string, patch: Partial<TransactionRecord>) => {
        updates.push({ id, patch });
        return { ...transaction, ...patch };
      },
    };
    const worker = new PaymentWorker(transactions as any, {} as any);

    const result = await worker.processBatch();

    assert.strictEqual(result.deadLettered, 1);
    assert.strictEqual(result.retried, 0);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0]?.patch.status, "dead");
  });

  it("dead-letters a failed payout after its retry budget is exhausted", async () => {
    const transaction = failedTransaction({ attempts: 3 });
    let updatedStatus: string | undefined;
    const transactions = {
      listByStatus: async () => [transaction],
      update: async (_id: string, patch: Partial<TransactionRecord>) => {
        updatedStatus = patch.status;
        return { ...transaction, ...patch };
      },
    };
    const worker = new PaymentWorker(transactions as any, {} as any, undefined, {
      failedRetryMax: 3,
    });

    const result = await worker.processBatch();

    assert.strictEqual(result.deadLettered, 1);
    assert.strictEqual(updatedStatus, "dead");
  });

  it("waits until exponential backoff has elapsed before retrying", async () => {
    const transaction = failedTransaction({ updatedAt: new Date(), attempts: 2 });
    let updateCalls = 0;
    const transactions = {
      listByStatus: async () => [transaction],
      update: async () => {
        updateCalls += 1;
        return transaction;
      },
    };
    const worker = new PaymentWorker(transactions as any, {} as any, undefined, {
      failedRetryBaseMs: 60_000,
    });

    const result = await worker.processBatch();

    assert.strictEqual(result.retried, 0);
    assert.strictEqual(result.deadLettered, 0);
    assert.strictEqual(updateCalls, 0);
  });

  it("requeues a failed payout after exponential backoff has elapsed", async () => {
    const transaction = failedTransaction({ updatedAt: new Date(0), attempts: 2 });
    let updatedStatus: string | undefined;
    const transactions = {
      listByStatus: async () => [transaction],
      update: async (_id: string, patch: Partial<TransactionRecord>) => {
        updatedStatus = patch.status;
        return { ...transaction, ...patch };
      },
    };
    const worker = new PaymentWorker(transactions as any, {} as any, undefined, {
      failedRetryBaseMs: 1,
    });

    const result = await worker.processBatch();

    assert.strictEqual(result.retried, 1);
    assert.strictEqual(updatedStatus, "queued");
  });
});
