import type { PaymentStatus, TransactionRecord } from "../types/payment";
import type { TransactionRepository } from "./transactionRepository";

export class InMemoryTransactionRepository implements TransactionRepository {
  private readonly records = new Map<string, TransactionRecord>();
  private readonly idempotencyMap = new Map<string, string>();
  private readonly nonceBySource = new Map<string, number>();

  async findByIdempotencyKey(idempotencyKey: string): Promise<TransactionRecord | null> {
    const id = this.idempotencyMap.get(idempotencyKey);
    if (!id) return null;
    return this.records.get(id) ?? null;
  }

  async findById(id: string): Promise<TransactionRecord | null> {
    return this.records.get(id) ?? null;
  }

  async reserveNextNonce(sourceAccount: string): Promise<number> {
    const current = this.nonceBySource.get(sourceAccount) ?? 0;
    const next = current + 1;
    this.nonceBySource.set(sourceAccount, next);
    return next;
  }

  async insert(record: TransactionRecord): Promise<void> {
    this.records.set(record.id, record);
    this.idempotencyMap.set(record.idempotencyKey, record.id);
  }

  async update(
    id: string,
    patch: Partial<Omit<TransactionRecord, "id" | "createdAt">>
  ): Promise<TransactionRecord> {
    const current = this.records.get(id);
    if (!current) {
      throw new Error(`Transaction ${id} not found`);
    }
    const updated: TransactionRecord = {
      ...current,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date(),
    };
    this.records.set(id, updated);
    return updated;
  }

  async listByStatus(statuses: PaymentStatus[], limit: number): Promise<TransactionRecord[]> {
    const statusSet = new Set(statuses);
    const rows = Array.from(this.records.values())
      .filter((record) => statusSet.has(record.status))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return rows.slice(0, limit);
  }
}

