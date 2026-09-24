import { Worker, type Job } from "bullmq";
import type { PaymentService } from "../services/paymentService";
import { TX_CONFIRM_QUEUE, type ConfirmJobData } from "../queues/txQueue";
import { logger } from "../utils/logger";
import type { TransactionStateMachine } from "../services/transactionStateMachine";
import { TransactionState } from "../domain/transactionState";
import {
  workerActiveJobsGauge,
  workerJobAttemptsTotal,
  workerJobProcessingDuration,
  workerJobRetriesTotal,
  workerJobsSuccessTotal,
  workerLifecycleEventsTotal,
  workerTerminalFailuresTotal,
} from "../utils/metrics";

const QUEUE_LABELS = { queue: TX_CONFIRM_QUEUE } as const;
const WORKER_LABELS = { worker: "tx-reconciler" } as const;
const processingStartedAt = new WeakMap<object, number>();

export interface TxReconcilerWorkerOptions {
  concurrency?: number;
}

export type TxReconcilerStateMachine = Pick<
  TransactionStateMachine,
  "confirmSubmitted" | "markDead"
>;

export async function reconcileSubmittedTransaction(
  job: Job<ConfirmJobData>,
  paymentService: PaymentService,
  transactionStateMachine: TxReconcilerStateMachine,
): Promise<void> {
  const txStatus = await transactionStateMachine.confirmSubmitted(job.data.transactionId);

  if (txStatus === TransactionState.SUBMITTED) {
    throw new Error(`Transaction ${job.data.transactionId} still pending on-chain`);
  }
}

export function observeTxJobActive(job: Job<ConfirmJobData>): void {
  workerJobAttemptsTotal.inc(QUEUE_LABELS);
  workerLifecycleEventsTotal.inc({ ...WORKER_LABELS, event: "active" });
  processingStartedAt.set(job, Date.now());
}

export function observeTxJobFinished(job: Job<ConfirmJobData>): void {
  const started = processingStartedAt.get(job);
  processingStartedAt.delete(job);
  const processedOn = started ?? job.processedOn;
  if (typeof processedOn !== "number" || !Number.isFinite(processedOn)) return;
  const duration = Math.max(0, (Date.now() - processedOn) / 1000);
  workerJobProcessingDuration.observe(QUEUE_LABELS, duration);
}

export function observeTxJobCompleted(job: Job<ConfirmJobData>): void {
  observeTxJobFinished(job);
  workerJobsSuccessTotal.inc(QUEUE_LABELS);
  observeLifecycle("completed");
}

function observeLifecycle(event: string): void {
  workerLifecycleEventsTotal.inc({ ...WORKER_LABELS, event });
}

export async function handleTxReconcilerFailure(
  job: Job<ConfirmJobData> | undefined,
  err: Error,
  transactionStateMachine: TxReconcilerStateMachine,
): Promise<void> {
  if (!job) {
    workerTerminalFailuresTotal.inc({
      queue: TX_CONFIRM_QUEUE,
      reason: "missing_job",
    });
    logger.error(
      { event: "tx_reconciler_failure", outcome: "failure", reason: "missing_job" },
      "TxReconciler failed without a job",
    );
    return;
  }
  const maxAttempts = job.opts.attempts ?? 10;
  if (job.attemptsMade < maxAttempts) {
    workerJobRetriesTotal.inc(QUEUE_LABELS);
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

  workerTerminalFailuresTotal.inc({
    queue: TX_CONFIRM_QUEUE,
    reason: "retries_exhausted",
  });
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
  transactionStateMachine: TxReconcilerStateMachine,
  options: TxReconcilerWorkerOptions = {},
): Worker<ConfirmJobData> {
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Worker concurrency must be a positive integer");
  }

  const worker = new Worker<ConfirmJobData>(
    TX_CONFIRM_QUEUE,
    async (job: Job<ConfirmJobData>) => reconcileSubmittedTransaction(job, paymentService, transactionStateMachine),
    {
      connection: { url: process.env.REDIS_URL ?? "redis://localhost:6379" },
      concurrency,
    },
  );

  let activeJobs = 0;
  const setActiveJobs = (value: number): void => {
    activeJobs = Math.max(0, value);
    workerActiveJobsGauge.set(WORKER_LABELS, activeJobs);
  };

  worker.on("active", (job: Job<ConfirmJobData>) => {
    setActiveJobs(activeJobs + 1);
    observeTxJobActive(job);
  });

  worker.on("completed", (job: Job<ConfirmJobData>) => {
    setActiveJobs(activeJobs - 1);
    observeTxJobCompleted(job);
  });

  worker.on("failed", async (job: Job<ConfirmJobData> | undefined, err: Error) => {
    if (job) {
      setActiveJobs(activeJobs - 1);
      observeTxJobFinished(job);
    }
    observeLifecycle("failed");
    await handleTxReconcilerFailure(job, err, transactionStateMachine);
  });

  worker.on("error", (err: Error) => {
    observeLifecycle("error");
    logger.error({ err }, "TxReconciler worker error");
  });

  worker.on("ready", () => {
    observeLifecycle("ready");
  });

  worker.on("paused", () => {
    observeLifecycle("paused");
  });

  worker.on("resumed", () => {
    observeLifecycle("resumed");
  });

  worker.on("closed", () => {
    setActiveJobs(0);
    observeLifecycle("closed");
  });

  return worker;
}
