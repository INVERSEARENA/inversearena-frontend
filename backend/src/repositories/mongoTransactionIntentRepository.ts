import { TransactionIntentModel } from "../db/models/transactionIntent.model";
import type { IntentKind, IntentStatus, TransactionIntentRecord } from "../types/transactionIntent";
import type { TransactionIntentRepository } from "./transactionIntentRepository";

function docToRecord(doc: { toObject(): Record<string, unknown> } & { _id: string }): TransactionIntentRecord {
  const obj = doc.toObject() as Record<string, unknown>;
  return {
    id: obj._id as string,
    idempotencyKey: obj.idempotencyKey as string,
    kind: obj.kind as IntentKind,
    ownerWallet: obj.ownerWallet as string,
    status: obj.status as IntentStatus,
    unsignedXdr: obj.unsignedXdr as string,
    signedXdr: (obj.signedXdr as string | null) ?? null,
    txHash: (obj.txHash as string | null) ?? null,
    errorMessage: (obj.errorMessage as string | null) ?? null,
    attempts: obj.attempts as number,
    signAttempts: obj.signAttempts as number,
    createdAt: obj.createdAt as Date,
    updatedAt: obj.updatedAt as Date,
    expiresAt: obj.expiresAt as Date,
    confirmedAt: (obj.confirmedAt as Date | null) ?? null,
  };
}

export class MongoTransactionIntentRepository implements TransactionIntentRepository {
  async findByIdempotencyKey(idempotencyKey: string): Promise<TransactionIntentRecord | null> {
    const doc = await TransactionIntentModel.findOne({ idempotencyKey });
    return doc ? docToRecord(doc) : null;
  }

  async findById(id: string): Promise<TransactionIntentRecord | null> {
    const doc = await TransactionIntentModel.findById(id);
    return doc ? docToRecord(doc) : null;
  }

  async insert(record: TransactionIntentRecord): Promise<void> {
    await TransactionIntentModel.create({
      _id: record.id,
      idempotencyKey: record.idempotencyKey,
      kind: record.kind,
      ownerWallet: record.ownerWallet,
      status: record.status,
      unsignedXdr: record.unsignedXdr,
      signedXdr: record.signedXdr ?? null,
      txHash: record.txHash ?? null,
      errorMessage: record.errorMessage ?? null,
      attempts: record.attempts,
      signAttempts: record.signAttempts,
      expiresAt: record.expiresAt,
      confirmedAt: record.confirmedAt ?? null,
    });
  }

  async update(
    id: string,
    patch: Partial<Omit<TransactionIntentRecord, "id" | "createdAt">>
  ): Promise<TransactionIntentRecord> {
    const doc = await TransactionIntentModel.findByIdAndUpdate(
      id,
      { $set: patch },
      { new: true, runValidators: true }
    );
    if (!doc) {
      throw new Error(`TransactionIntent ${id} not found`);
    }
    return docToRecord(doc);
  }

  async listByStatus(statuses: IntentStatus[], limit: number): Promise<TransactionIntentRecord[]> {
    if (statuses.length === 0 || limit <= 0) return [];
    const docs = await TransactionIntentModel.find({ status: { $in: statuses } })
      .sort({ createdAt: 1 })
      .limit(limit);
    return docs.map(docToRecord);
  }
}
