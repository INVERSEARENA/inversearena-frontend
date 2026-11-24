import { DelayedError, Worker, type Job } from "bullmq";
import type { PaymentService } from "../services/paymentService";
import {
  RECONCILE_QUEUE,
  TX_CONFIRM_QUEUE,
  deadLetterJob,
  type ConfirmJobData,
} from "../queues/txQueue";
import { ReconcileJob, type ReconcileJobPayload } from "../queues/jobDefinition";
import { logger } from "../utils/logger";
import type { TransactionStateMachine } from "../services/transactionStateMachine";
import { TransactionState } from "../domain/transactionState";
import { refreshLedgerIdentity } from "../services/ledgerClock";
import { getRollbackGuard } from "../services/ledgerContinuity";
import {
  workerActiveJobsGauge,
  workerJobAttemptsTotal,
  workerJobProcessingDuration,
  workerJobRetriesTotal,
  workerJobsSuccessTotal,
  workerLifecycleEventsTotal,
  workerTerminalFailuresTotal,
  ledgerRollbackAffectedConsumersTotal,
} from "../utils/metrics";
import { env } from "../config/env";

/** Queue label for the reconcile worker — uses the new RECONCILE_QUEUE name. */
const QUEUE_LABELS = { queue: RECONCILE_QUEUE } as const;
const WORKER_LABELS = { worker: "tx-reconciler" } as const;
const processingStartedAt = new WeakMap<object, number>();

/** How long a confirmation job waits before re-checking while ledger rollback recovery is active (#1490). */
export const ROLLBACK_RECOVERY_RETRY_DELAY_MS = 15_000;

export interface TxReconcilerWorkerOptions {
  concurrency?: number;
}

export type TxReconcilerStateMachine = Pick<
  TransactionStateMachine,
  "confirmSubmitted" | "markDead"
>;

/**
 * Resolve the transaction ID from a reconcile job.
 *
 * Accepts both the new versioned `ReconcileJobPayload` (v:1, transactionId uuid)
 * and the legacy `ConfirmJobData` shape (plain `{ transactionId }`) that may
 * still be in the queue during the rolling-deploy window.  Unknown or structurally
 * invalid payloads are dead-lettered via `deadLetterJob` and return `null`.
 */
function resolveTransactionId(job: Job<ConfirmJobData | ReconcileJobPayload>): string | null {
  // Try the versioned schema first (new producers).
  const parsed = ReconcileJob.parse(job.data);
  if (parsed !== null) return parsed.transactionId;

  // Fall back to the legacy ConfirmJobData shape (no `v` field) for jobs
  // already in the queue before the migration.
  const legacy = job.data as Record<string, unknown>;
  if (typeof legacy["transactionId"] === "string" && legacy["transactionId"].length > 0) {
    return legacy["transactionId"];
  }

  // Neither format matched — dead-letter the job.
  deadLetterJob({
    queue: RECONCILE_QUEUE,
    jobId: job.id,
    reason: "unrecognised_payload_shape",
    raw: job.data,
  });
  return null;
}

export async function reconcileSubmittedTransaction(
  job: Job<ConfirmJobData | ReconcileJobPayload>,
  paymentService: PaymentService,
  transactionStateMachine: TxReconcilerStateMachine,
  token?: string,
): Promise<void> {
  const transactionId = resolveTransactionId(job);
  if (transactionId === null) {
    // Dead-lettered; skip processing without throwing (avoids a noisy retry loop).
    return;
  }

  // A confirmation read during rollback recovery could observe a ledger that
  // is no longer canonical (#1490), so the job is deferred instead of
  // confirming. moveToDelayed + DelayedError keeps the deferral from
  // consuming one of the job's retry attempts.
  await refreshLedgerIdentity();
  if (getRollbackGuard().isQuarantined()) {
    ledgerRollbackAffectedConsumersTotal.inc({ consumer: "tx-reconciler" });
    logger.warn(
      { event: "tx_reconciler_deferred", transactionId },
      "Transaction confirmation deferred during ledger rollback recovery",
    );
    if (token !== undefined && typeof job.moveToDelayed === "function") {
      await job.moveToDelayed(Date.now() + ROLLBACK_RECOVERY_RETRY_DELAY_MS, token);
      throw new DelayedError();
    }
    throw new Error("Ledger rollback recovery is active; confirmation deferred");
  }

  const txStatus = await transactionStateMachine.confirmSubmitted(transactionId);

  if (txStatus === TransactionState.SUBMITTED) {
    throw new Error(`Transaction ${transactionId} still pending on-chain`);
  }
}

export function observeTxJobActive(job: Job<ConfirmJobData | ReconcileJobPayload>): void {
  workerJobAttemptsTotal.inc(QUEUE_LABELS);
  workerLifecycleEventsTotal.inc({ ...WORKER_LABELS, event: "active" });
  processingStartedAt.set(job, Date.now());
}

export function observeTxJobFinished(job: Job<ConfirmJobData | ReconcileJobPayload>): void {
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
  job: Job<ConfirmJobData | ReconcileJobPayload> | undefined,
  err: Error,
  transactionStateMachine: TxReconcilerStateMachine,
): Promise<void> {
  if (!job) {
    workerTerminalFailuresTotal.inc({
      queue: RECONCILE_QUEUE,
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
    queue: RECONCILE_QUEUE,
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
): Worker<ConfirmJobData | ReconcileJobPayload> {
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Worker concurrency must be a positive integer");
  }

  const worker = new Worker<ConfirmJobData | ReconcileJobPayload>(
    RECONCILE_QUEUE,
    async (job: Job<ConfirmJobData | ReconcileJobPayload>, token?: string) =>
      reconcileSubmittedTransaction(job, paymentService, transactionStateMachine, token),
    {
      connection: { url: env.REDIS_URL ?? "redis://localhost:6379" },
      concurrency,
    },
  );

  let activeJobs = 0;
  const setActiveJobs = (value: number): void => {
    activeJobs = Math.max(0, value);
    workerActiveJobsGauge.set(WORKER_LABELS, activeJobs);
  };

  worker.on("active", (job: Job<ConfirmJobData | ReconcileJobPayload>) => {
    setActiveJobs(activeJobs + 1);
    observeTxJobActive(job);
  });

  worker.on("completed", (job: Job<ConfirmJobData | ReconcileJobPayload>) => {
    setActiveJobs(activeJobs - 1);
    observeTxJobCompleted(job);
  });

  worker.on("failed", async (job: Job<ConfirmJobData | ReconcileJobPayload> | undefined, err: Error) => {
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
