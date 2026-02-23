import { TransactionModel } from "../db/models/transaction.model";
import type { PaymentStatus, TransactionRecord } from "../types/payment";
import type { TransactionRepository } from "./transactionRepository";

function docToRecord(doc: { toObject(): Record<string, unknown> } & { _id: string }): TransactionRecord {
  const obj = doc.toObject() as Record<string, unknown>;
  return {
    id: obj._id as string,
    payoutId: obj.payoutId as string,
    idempotencyKey: obj.idempotencyKey as string,
    sourceAccount: obj.sourceAccount as string,
    destinationAccount: obj.destinationAccount as string,
    asset: obj.asset as "XLM" | "USDC",
    amountStroops: obj.amountStroops as string,
    nonce: obj.nonce as number,
    status: obj.status as PaymentStatus,
    unsignedXdr: obj.unsignedXdr as string,
    signedXdr: (obj.signedXdr as string | null) ?? null,
    txHash: (obj.txHash as string | null) ?? null,
    errorMessage: (obj.errorMessage as string | null) ?? null,
    attempts: obj.attempts as number,
    createdAt: obj.createdAt as Date,
    updatedAt: obj.updatedAt as Date,
    confirmedAt: (obj.confirmedAt as Date | null) ?? null,
  };
}

export class MongoTransactionRepository implements TransactionRepository {
  async findByIdempotencyKey(idempotencyKey: string): Promise<TransactionRecord | null> {
    const doc = await TransactionModel.findOne({ idempotencyKey });
    return doc ? docToRecord(doc) : null;
  }

  async findById(id: string): Promise<TransactionRecord | null> {
    const doc = await TransactionModel.findById(id);
    return doc ? docToRecord(doc) : null;
  }

  async reserveNextNonce(sourceAccount: string): Promise<number> {
    const doc = await TransactionModel
      .findOne({ sourceAccount })
      .sort({ nonce: -1 })
      .select("nonce")
      .lean();
    return (doc?.nonce ?? 0) + 1;
  }

  async insert(record: TransactionRecord): Promise<void> {
    await TransactionModel.create({
      _id: record.id,
      payoutId: record.payoutId,
      idempotencyKey: record.idempotencyKey,
      sourceAccount: record.sourceAccount,
      destinationAccount: record.destinationAccount,
      asset: record.asset,
      amountStroops: record.amountStroops,
      nonce: record.nonce,
      status: record.status,
      unsignedXdr: record.unsignedXdr,
      signedXdr: record.signedXdr ?? null,
      txHash: record.txHash ?? null,
      errorMessage: record.errorMessage ?? null,
      attempts: record.attempts,
      confirmedAt: record.confirmedAt ?? null,
    });
  }

  async update(
    id: string,
    patch: Partial<Omit<TransactionRecord, "id" | "createdAt">>
  ): Promise<TransactionRecord> {
    const doc = await TransactionModel.findByIdAndUpdate(
      id,
      { $set: patch },
      { new: true, runValidators: true }
    );
    if (!doc) {
      throw new Error(`Transaction ${id} not found`);
    }
    return docToRecord(doc);
  }

  async listByStatus(statuses: PaymentStatus[], limit: number): Promise<TransactionRecord[]> {
    if (statuses.length === 0 || limit <= 0) return [];
    const docs = await TransactionModel
      .find({ status: { $in: statuses } })
      .sort({ createdAt: 1 })
      .limit(limit);
    return docs.map(docToRecord);
  }
}
