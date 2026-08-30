import type { Job } from "bullmq";
import type { TransactionRepository } from "../src/repositories/transactionRepository";
import type { PaymentService } from "../src/services/paymentService";
import type { ConfirmJobData } from "../src/queues/txQueue";
import {
  handleTxReconcilerFailure,
  reconcileSubmittedTransaction,
} from "../src/workers/txReconciler";

function job(attemptsMade = 1, attempts = 10): Job<ConfirmJobData> {
  return {
    data: { transactionId: "tx-1" },
    attemptsMade,
    opts: { attempts },
  } as Job<ConfirmJobData>;
}

function paymentServiceWithStatus(status: "submitted" | "confirmed" | "failed") {
  return {
    confirmSubmittedTransaction: jest.fn(async () => ({ status })),
  } as unknown as PaymentService;
}

describe("txReconciler (#1226)", () => {
  it("throws for a transaction that is still pending so BullMQ retries it", async () => {
    await expect(
      reconcileSubmittedTransaction(job(), paymentServiceWithStatus("submitted")),
    ).rejects.toThrow("Transaction tx-1 still pending on-chain");
  });

  it.each(["confirmed", "failed"] as const)(
    "completes terminal %s transactions without retrying",
    async (status) => {
      await expect(
        reconcileSubmittedTransaction(job(), paymentServiceWithStatus(status)),
      ).resolves.toBeUndefined();
    },
  );

  it("does nothing when BullMQ cannot provide the failed job", async () => {
    const update = jest.fn();
    await handleTxReconcilerFailure(
      undefined,
      new Error("connection lost"),
      { update } as unknown as TransactionRepository,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("leaves a failed job retryable while attempts remain", async () => {
    const update = jest.fn();
    await handleTxReconcilerFailure(
      job(2, 3),
      new Error("still unavailable"),
      { update } as unknown as TransactionRepository,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("dead-letters a confirmation job after all attempts are exhausted", async () => {
    const update = jest.fn(async () => ({ status: "dead" }));
    await handleTxReconcilerFailure(
      job(3, 3),
      new Error("RPC timeout"),
      { update } as unknown as TransactionRepository,
    );

    expect(update).toHaveBeenCalledWith(
      "tx-1",
      expect.objectContaining({
        status: "dead",
        errorMessage: "Confirmation failed after 3 attempts: RPC timeout",
        updatedAt: expect.any(Date),
      }),
    );
  });
});
