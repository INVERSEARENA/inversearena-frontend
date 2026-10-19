import type { Job } from "bullmq";
import type { PaymentService } from "../src/services/paymentService";
import type { ConfirmJobData } from "../src/queues/txQueue";
import { TransactionState } from "../src/domain/transactionState";
import {
  handleTxReconcilerFailure,
  reconcileSubmittedTransaction,
  type TxReconcilerStateMachine,
} from "../src/workers/txReconciler";

function job(attemptsMade = 1, attempts = 10): Job<ConfirmJobData> {
  return {
    data: { transactionId: "tx-1" },
    attemptsMade,
    opts: { attempts },
  } as Job<ConfirmJobData>;
}

function paymentService(): PaymentService {
  return {} as PaymentService;
}

function stateMachine(
  status: TransactionState,
  markDead = jest.fn(async () => undefined),
): TxReconcilerStateMachine {
  return {
    confirmSubmitted: jest.fn(async () => status),
    markDead,
  };
}

describe("txReconciler", () => {
  it("throws while a transaction remains submitted", async () => {
    await expect(
      reconcileSubmittedTransaction(
        job(),
        paymentService(),
        stateMachine(TransactionState.SUBMITTED),
      ),
    ).rejects.toThrow("Transaction tx-1 still pending on-chain");
  });

  it.each([TransactionState.CONFIRMED, TransactionState.FAILED])(
    "completes terminal %s transactions",
    async (status) => {
      await expect(
        reconcileSubmittedTransaction(
          job(),
          paymentService(),
          stateMachine(status),
        ),
      ).resolves.toBeUndefined();
    },
  );

  it("handles a failed event without a job", async () => {
    const machine = stateMachine(TransactionState.SUBMITTED);
    await expect(
      handleTxReconcilerFailure(
        undefined,
        new Error("connection lost"),
        machine,
      ),
    ).resolves.toBeUndefined();
    expect(machine.markDead).not.toHaveBeenCalled();
  });

  it("leaves a failed job retryable while attempts remain", async () => {
    const machine = stateMachine(TransactionState.SUBMITTED);
    await handleTxReconcilerFailure(
      job(2, 3),
      new Error("still unavailable"),
      machine,
    );
    expect(machine.markDead).not.toHaveBeenCalled();
  });

  it("dead-letters a job after retries are exhausted", async () => {
    const machine = stateMachine(TransactionState.SUBMITTED);
    await handleTxReconcilerFailure(
      job(3, 3),
      new Error("RPC timeout"),
      machine,
    );
    expect(machine.markDead).toHaveBeenCalledWith(
      "tx-1",
      "Confirmation failed after 3 attempts: RPC timeout",
    );
  });
});
