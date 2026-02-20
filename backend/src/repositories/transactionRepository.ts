import type { PaymentStatus, TransactionRecord } from "../types/payment";

export interface TransactionRepository {
  findByIdempotencyKey(idempotencyKey: string): Promise<TransactionRecord | null>;
  findById(id: string): Promise<TransactionRecord | null>;
  reserveNextNonce(sourceAccount: string): Promise<number>;
  insert(record: TransactionRecord): Promise<void>;
  update(
    id: string,
    patch: Partial<Omit<TransactionRecord, "id" | "createdAt">>
  ): Promise<TransactionRecord>;
  listByStatus(statuses: PaymentStatus[], limit: number): Promise<TransactionRecord[]>;
}

