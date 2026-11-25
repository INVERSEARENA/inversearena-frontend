import type { TransactionRepository } from "../repositories/transactionRepository";
import { TransactionState } from "../domain/transactionState";
import { logger } from "../utils/logger";

export class TransactionStateMachine {
  constructor(private transactions: TransactionRepository) {}

  async confirmSubmitted(transactionId: string): Promise<TransactionState> {
    const tx = await this.transactions.findById(transactionId);
    if (!tx) {
      logger.warn({ transactionId }, "Transaction not found for confirmation");
      return TransactionState.UNKNOWN;
    }

    if (tx.status === TransactionState.SUBMITTED) {
      // This is where actual on-chain confirmation logic would go.
      // For now, we simulate success or failure.
      // In a real scenario, this would involve calling out to Stellar/Soroban RPC.
      const isConfirmed = Math.random() > 0.5; // Simulate success/failure
      const newStatus = isConfirmed ? TransactionState.CONFIRMED : TransactionState.FAILED;
      await this.transactions.update(transactionId, {
        status: newStatus,
        updatedAt: new Date(),
      });
      logger.info({ transactionId, newStatus }, "Transaction status updated after confirmation attempt");
      return newStatus;
    }
    return tx.status as TransactionState; // Already in a terminal state or not submitted
  }

  async markFailed(transactionId: string, errorMessage: string): Promise<void> {
    await this.transactions.update(transactionId, {
      status: TransactionState.FAILED,
      errorMessage,
      updatedAt: new Date(),
    });
    logger.error({ transactionId, errorMessage }, "Transaction marked as FAILED");
  }

  async markDead(transactionId: string, errorMessage: string): Promise<void> {
    await this.transactions.update(transactionId, {
      status: TransactionState.DEAD,
      errorMessage,
      updatedAt: new Date(),
    });
    logger.error({ transactionId, errorMessage }, "Transaction marked as DEAD after retries exhausted");
  }

  async markUnknown(transactionId: string): Promise<void> {
    await this.transactions.update(transactionId, {
      status: TransactionState.UNKNOWN,
      updatedAt: new Date(),
    });
    logger.warn({ transactionId }, "Transaction status marked as UNKNOWN");
  }
}
