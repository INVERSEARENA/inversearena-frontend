import type { PaymentStatus } from "../types/payment";
import { PaymentService } from "../services/paymentService";
import type { TransactionRepository } from "../repositories/transactionRepository";
import { workerJobsPending, txsConfirmedTotal } from "../utils/metrics";

export interface PaymentWorkerResult {
  processed: number;
  submitted: number;
  confirmed: number;
  failed: number;
}

export class PaymentWorker {
  constructor(
    private readonly transactions: TransactionRepository,
    private readonly paymentService: PaymentService
  ) {}

  async processBatch(limit = 25): Promise<PaymentWorkerResult> {
    const statuses: PaymentStatus[] = ["queued", "submitted"];
    const pending = await this.transactions.listByStatus(statuses, limit);

    workerJobsPending.set({ job_type: 'payment' }, pending.length);

    let submitted = 0;
    let confirmed = 0;
    let failed = 0;

    for (const transaction of pending) {
      if (transaction.status === "queued") {
        const result = await this.paymentService.submitQueuedTransaction(transaction.id);
        if (result.submitted) {
          submitted += 1;
        }
        if (result.transaction.status === "failed") {
          failed += 1;
          txsConfirmedTotal.inc({ status: 'failed' });
        }
        continue;
      }

      const refreshed = await this.paymentService.confirmSubmittedTransaction(transaction.id);
      if (refreshed.status === "confirmed") {
        confirmed += 1;
        txsConfirmedTotal.inc({ status: 'confirmed' });
      } else if (refreshed.status === "failed") {
        failed += 1;
        txsConfirmedTotal.inc({ status: 'failed' });
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
