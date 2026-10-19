import type { Queue } from "bullmq";
import type { PaymentStatus, TransactionRecord } from "../types/payment";
import { PaymentService } from "../services/paymentService";
import type { TransactionRepository } from "../repositories/transactionRepository";
import type { ConfirmJobData } from "../queues/txQueue";
import { workerJobsPending, txsConfirmedTotal, payoutsDeadLetterTotal } from "../utils/metrics";
import { logger, reportErrorToSentry } from "../utils/logger";

export interface PaymentWorkerResult {
  processed: number;
  submitted: number;
  confirmed: number;
  failed: number;
  retried: number;
  deadLettered: number;
}

export interface PaymentWorkerRetryOptions {
  /** Max retry cycles for a payout in "failed" status before dead-lettering. */
  failedRetryMax?: number;
  /** Base delay for the exponential backoff between failed-payout retries. */
  failedRetryBaseMs?: number;
}

const DEFAULT_FAILED_RETRY_MAX = 3;
const DEFAULT_FAILED_RETRY_BASE_MS = 5_000;

export class PaymentWorker {
  private readonly failedRetryMax: number;
  private readonly failedRetryBaseMs: number;
  private isRunning = false;

  constructor(
    private readonly transactions: TransactionRepository,
    private readonly paymentService: PaymentService,
    private readonly txQueue?: Queue<ConfirmJobData>,
    retryOptions: PaymentWorkerRetryOptions = {}
  ) {
    this.failedRetryMax = retryOptions.failedRetryMax ?? DEFAULT_FAILED_RETRY_MAX;
    this.failedRetryBaseMs = retryOptions.failedRetryBaseMs ?? DEFAULT_FAILED_RETRY_BASE_MS;
  }

  async processBatch(limit = 25): Promise<PaymentWorkerResult> {
    if (this.isRunning) {
      logger.warn("PaymentWorker.processBatch: batch run already in progress, skipping concurrent execution");
      return {
        processed: 0,
        submitted: 0,
        confirmed: 0,
        failed: 0,
        retried: 0,
        deadLettered: 0,
      };
    }

    this.isRunning = true;
    try {
      const statuses: PaymentStatus[] = ["queued", "submitted", "failed"];
      const pending = await this.transactions.listByStatus(statuses, limit);

      workerJobsPending.set({ job_type: 'payment' }, pending.length);

      let submitted = 0;
      let confirmed = 0;
      let failed = 0;
      let retried = 0;
      let deadLettered = 0;

      for (const transaction of pending) {
        try {
          // "failed" status (#1122): retry with exponential backoff up to a
          // configurable limit, then dead-letter and alert — never skip silently.
          if (transaction.status === "failed") {
            const outcome = await this.handleFailedTransaction(transaction);
            if (outcome === "retried") retried += 1;
            if (outcome === "dead") deadLettered += 1;
            continue;
          }

          if (transaction.status === "queued") {
            const result = await this.paymentService.submitQueuedTransaction(transaction.id);
            if (result.submitted) {
              submitted += 1;
              // Hand off confirmation polling to BullMQ for persistent retry with backoff
              if (this.txQueue) {
                await this.txQueue.add("confirm", { transactionId: transaction.id });
              }
            }
            if (result.transaction.status === "failed") {
              failed += 1;
              txsConfirmedTotal.inc({ status: "failed" });
            }
            continue;
          }

          // "submitted" status: only do inline confirmation if no BullMQ queue is configured
          // (fallback for test / no-Redis environments)
          if (this.txQueue) {
            continue;
          }

          const refreshed = await this.paymentService.confirmSubmittedTransaction(transaction.id);
          if (refreshed.status === "confirmed") {
            confirmed += 1;
            txsConfirmedTotal.inc({ status: "confirmed" });
          } else if (refreshed.status === "failed") {
            failed += 1;
            txsConfirmedTotal.inc({ status: "failed" });
          }
        } catch (error) {
          failed += 1;
          txsConfirmedTotal.inc({ status: "failed" });
          logger.error(
            {
              transactionId: transaction.id,
              error,
            },
            "PaymentWorker.processBatch: unexpected error",
          );
        }
      }

      return {
        processed: pending.length,
        submitted,
        confirmed,
        failed,
        retried,
        deadLettered,
      };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Handle a payout stuck in "failed" status (#1122).
   *
   * - Re-queues it for another submission attempt once the exponential
   *   backoff window (failedRetryBaseMs * 2^(attempts-1)) has elapsed.
   * - Once retries are exhausted — or the payout can never be resubmitted
   *   because no signed XDR exists — it is moved to the terminal "dead"
   *   status and a monitoring alert is emitted (log + metric + Sentry).
   */
  private async handleFailedTransaction(
    transaction: TransactionRecord
  ): Promise<"retried" | "dead" | "waiting"> {
    const retriable = Boolean(transaction.signedXdr);

    if (!retriable || transaction.attempts >= this.failedRetryMax) {
      const reason = retriable ? "retries_exhausted" : "missing_signed_xdr";
      await this.transactions.update(transaction.id, {
        status: "dead",
        errorMessage: `Dead-lettered after ${transaction.attempts} attempt(s): ${
          transaction.errorMessage ?? "unknown failure"
        }`,
        updatedAt: new Date(),
      });

      payoutsDeadLetterTotal.inc({ reason });
      logger.error(
        {
          transactionId: transaction.id,
          payoutId: transaction.payoutId,
          attempts: transaction.attempts,
          reason,
        },
        "PaymentWorker.processBatch: payout moved to dead-letter — manual intervention required",
      );
      reportErrorToSentry(
        new Error(
          `Payout ${transaction.payoutId} dead-lettered (transaction ${transaction.id}): ${
            transaction.errorMessage ?? "unknown failure"
          }`
        ),
        {
          transactionId: transaction.id,
          payoutId: transaction.payoutId,
          reason,
        },
      );
      return "dead";
    }

    const backoffMs = this.failedRetryBaseMs * 2 ** Math.max(transaction.attempts - 1, 0);
    const elapsedMs = Date.now() - transaction.updatedAt.getTime();
    if (elapsedMs < backoffMs) {
      return "waiting";
    }

    await this.transactions.update(transaction.id, {
      status: "queued",
      updatedAt: new Date(),
    });
    logger.warn(
      {
        transactionId: transaction.id,
        payoutId: transaction.payoutId,
        attempt: transaction.attempts + 1,
        failedRetryMax: this.failedRetryMax,
        backoffMs,
      },
      "PaymentWorker.processBatch: re-queueing failed payout for retry",
    );
    return "retried";
  }
}
