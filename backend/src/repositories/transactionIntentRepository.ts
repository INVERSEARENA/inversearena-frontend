import type { IntentStatus, TransactionIntentRecord } from "../types/transactionIntent";

export interface TransactionIntentRepository {
  findByIdempotencyKey(idempotencyKey: string): Promise<TransactionIntentRecord | null>;
  findById(id: string): Promise<TransactionIntentRecord | null>;
  insert(record: TransactionIntentRecord): Promise<void>;
  update(
    id: string,
    patch: Partial<Omit<TransactionIntentRecord, "id" | "createdAt">>
  ): Promise<TransactionIntentRecord>;
  listByStatus(statuses: IntentStatus[], limit: number): Promise<TransactionIntentRecord[]>;
}
