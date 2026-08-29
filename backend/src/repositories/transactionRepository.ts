import type { PaymentStatus, TransactionRecord } from "../types/payment";

export interface TransactionRepository {
  findByIdempotencyKey(idempotencyKey: string): Promise<TransactionRecord | null>;
  /**
   * Look a payout up by its business identifier rather than the caller-supplied
   * idempotency key, so a retry that generates a fresh key cannot mint a second
   * payout for the same prize (#1353).
   */
  findByPayoutId(payoutId: string): Promise<TransactionRecord | null>;
  findById(id: string): Promise<TransactionRecord | null>;
  reserveNextNonce(sourceAccount: string): Promise<number>;
  insert(record: TransactionRecord): Promise<void>;
  update(
    id: string,
    patch: Partial<Omit<TransactionRecord, "id" | "createdAt">>
  ): Promise<TransactionRecord>;
  listByStatus(statuses: PaymentStatus[], limit: number): Promise<TransactionRecord[]>;
}

