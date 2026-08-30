import { Worker, type Job } from "bullmq";
import type { PaymentService } from "../services/paymentService";
import type { TransactionRepository } from "../repositories/transactionRepository";
import { TX_CONFIRM_QUEUE, type ConfirmJobData } from "../queues/txQueue";
import { logger } from "../utils/logger";

export async function reconcileSubmittedTransaction(
  job: Job<ConfirmJobData>,
  paymentService: PaymentService,
): Promise<void> {
  const tx = await paymentService.confirmSubmittedTransaction(job.data.transactionId);

  if (tx.status === "submitted") {
    // Still pending on-chain — throw so BullMQ retries with exponential backoff
    throw new Error(`Transaction ${job.data.transactionId} still pending on-chain`);
  }
  // "confirmed" or "failed" are terminal states, so the job completes.
}

export async function handleTxReconcilerFailure(
  job: Job<ConfirmJobData> | undefined,
  err: Error,
  transactions: TransactionRepository,
): Promise<void> {
  if (!job) return;
  // job.opts.attempts is always set (txQueue.ts configures attempts: 10),
  // but BullMQ's type is optional — fall back to that same default.
  const maxAttempts = job.opts.attempts ?? 10;
  if (job.attemptsMade < maxAttempts) {
    logger.info(
      {
        transactionId: job.data.transactionId,
        attemptsMade: job.attemptsMade,
        maxAttempts,
        err,
      },
      "TxReconciler retry scheduled"
    );
    return;
  }

  await transactions.update(job.data.transactionId, {
    status: "dead",
    errorMessage: `Confirmation failed after ${maxAttempts} attempts: ${err.message}`,
    updatedAt: new Date(),
  });
  logger.error(
    {
      transactionId: job.data.transactionId,
      attemptsMade: job.attemptsMade,
      maxAttempts,
      err,
    },
    "TxReconciler exhausted retries"
  );
}

export function startTxReconcilerWorker(
  paymentService: PaymentService,
  transactions: TransactionRepository
): Worker<ConfirmJobData> {
  const worker = new Worker<ConfirmJobData>(
    TX_CONFIRM_QUEUE,
    async (job: Job<ConfirmJobData>) => reconcileSubmittedTransaction(job, paymentService),
    { connection: { url: process.env.REDIS_URL ?? "redis://localhost:6379" } }
  );

  // Dead-letter: fired on every failure attempt; only act when all retries are exhausted.
  // job.opts.attempts is always set because the queue's defaultJobOptions
  // configures attempts: 10 with exponential backoff (see txQueue.ts).
  worker.on("failed", async (job: Job<ConfirmJobData> | undefined, err: Error) => {
    await handleTxReconcilerFailure(job, err, transactions);
  });

  worker.on("error", (err: Error) => {
    logger.error({ err }, "TxReconciler worker error");
  });

  return worker;
}
