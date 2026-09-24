import type { IntentStatus, TransactionIntentRecord } from "../types/transactionIntent";
import type { TransactionIntentRepository } from "./transactionIntentRepository";

export class InMemoryTransactionIntentRepository implements TransactionIntentRepository {
  private readonly records = new Map<string, TransactionIntentRecord>();
  private readonly idempotencyMap = new Map<string, string>();

  async findByIdempotencyKey(idempotencyKey: string): Promise<TransactionIntentRecord | null> {
    const id = this.idempotencyMap.get(idempotencyKey);
    if (!id) return null;
    return this.records.get(id) ?? null;
  }

  async findById(id: string): Promise<TransactionIntentRecord | null> {
    return this.records.get(id) ?? null;
  }

  async insert(record: TransactionIntentRecord): Promise<void> {
    this.records.set(record.id, record);
    this.idempotencyMap.set(record.idempotencyKey, record.id);
  }

  async update(
    id: string,
    patch: Partial<Omit<TransactionIntentRecord, "id" | "createdAt">>
  ): Promise<TransactionIntentRecord> {
    const current = this.records.get(id);
    if (!current) {
      throw new Error(`TransactionIntent ${id} not found`);
    }
    const updated: TransactionIntentRecord = {
      ...current,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date(),
    };
    this.records.set(id, updated);
    return updated;
  }

  async listByStatus(statuses: IntentStatus[], limit: number): Promise<TransactionIntentRecord[]> {
    const statusSet = new Set(statuses);
    const rows = Array.from(this.records.values())
      .filter((record) => statusSet.has(record.status))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return rows.slice(0, limit);
  }
}
