import { Worker, type Job } from "bullmq";
import type { PaymentService } from "../services/paymentService";
import { TX_CONFIRM_QUEUE, type ConfirmJobData } from "../queues/txQueue";
import { logger } from "../utils/logger";
import { TransactionStateMachine } from "../services/transactionStateMachine";
import { TransactionState } from "../domain/transactionState";

export async function reconcileSubmittedTransaction(
  job: Job<ConfirmJobData>,
  paymentService: PaymentService,
  transactionStateMachine: TransactionStateMachine,
): Promise<void> {
  const txStatus = await transactionStateMachine.confirmSubmitted(job.data.transactionId);

  if (txStatus === TransactionState.SUBMITTED) {
    throw new Error(`Transaction ${job.data.transactionId} still pending on-chain`);
  }
}

export async function handleTxReconcilerFailure(
  job: Job<ConfirmJobData> | undefined,
  err: Error,
  transactionStateMachine: TransactionStateMachine,
): Promise<void> {
  if (!job) return;
  const maxAttempts = job.opts.attempts ?? 10;
  if (job.attemptsMade < maxAttempts) {
    logger.info(
      {
        transactionId: job.data.transactionId,
        attemptsMade: job.attemptsMade,
        maxAttempts,
        err,
      },
      "TxReconciler retry scheduled",
    );
    return;
  }

  await transactionStateMachine.markDead(job.data.transactionId, `Confirmation failed after ${maxAttempts} attempts: ${err.message}`);
  logger.error(
    {
      transactionId: job.data.transactionId,
      attemptsMade: job.attemptsMade,
      maxAttempts,
      err,
    },
    "TxReconciler exhausted retries",
  );
}

export function startTxReconcilerWorker(
  paymentService: PaymentService,
  transactionStateMachine: TransactionStateMachine,
): Worker<ConfirmJobData> {
  const worker = new Worker<ConfirmJobData>(
    TX_CONFIRM_QUEUE,
    async (job: Job<ConfirmJobData>) => reconcileSubmittedTransaction(job, paymentService, transactionStateMachine),
    { connection: { url: process.env.REDIS_URL ?? "redis://localhost:6379" } },
  );

  worker.on("failed", async (job: Job<ConfirmJobData> | undefined, err: Error) => {
    await handleTxReconcilerFailure(job, err, transactionStateMachine);
  });

  worker.on("error", (err: Error) => {
    logger.error({ err }, "TxReconciler worker error");
  });

  return worker;
}
