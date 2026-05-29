import type { Queue } from "bullmq";
import type { PaymentStatus } from "../types/payment";
import { PaymentService } from "../services/paymentService";
import type { TransactionRepository } from "../repositories/transactionRepository";
import type { ConfirmJobData } from "../queues/txQueue";
import { workerJobsPending, txsConfirmedTotal } from "../utils/metrics";
import { logger } from "../utils/logger";

export interface PaymentWorkerResult {
  processed: number;
  submitted: number;
  confirmed: number;
  failed: number;
}

export class PaymentWorker {
  constructor(
    private readonly transactions: TransactionRepository,
    private readonly paymentService: PaymentService,
    private readonly txQueue?: Queue<ConfirmJobData>
  ) {}

  async processBatch(limit = 25): Promise<PaymentWorkerResult> {
    const statuses: PaymentStatus[] = ["queued", "submitted"];
    const pending = await this.transactions.listByStatus(statuses, limit);

    workerJobsPending.set({ job_type: 'payment' }, pending.length);

    let submitted = 0;
    let confirmed = 0;
    let failed = 0;

    for (const transaction of pending) {
      try {
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
    };
  }
}
