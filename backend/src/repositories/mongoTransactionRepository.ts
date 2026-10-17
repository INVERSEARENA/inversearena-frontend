import { TransactionModel } from "../db/models/transaction.model";
import { PayoutNonceCounterModel } from "../db/models/payoutNonceCounter.model";
import type { PaymentStatus, TransactionRecord } from "../types/payment";
import type { TransactionPatch, TransactionRepository } from "./transactionRepository";

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
    ownerId: (obj.ownerId as string | null) ?? null,
    principal: (obj.principal as number | null) ?? null,
    yieldAmount: (obj.yieldAmount as number | null) ?? null,
    platformFee: (obj.platformFee as number | null) ?? null,
    dust: (obj.dust as number | null) ?? null,
  };
}

export class MongoTransactionRepository implements TransactionRepository {
  async findByIdempotencyKey(idempotencyKey: string): Promise<TransactionRecord | null> {
    const doc = await TransactionModel.findOne({ idempotencyKey });
    return doc ? docToRecord(doc) : null;
  }

  async findByPayoutId(payoutId: string): Promise<TransactionRecord | null> {
    const doc = await TransactionModel.findOne({ payoutId });
    return doc ? docToRecord(doc) : null;
  }

  async findById(id: string): Promise<TransactionRecord | null> {
    const doc = await TransactionModel.findById(id);
    return doc ? docToRecord(doc) : null;
  }

  async reserveNextNonce(sourceAccount: string): Promise<number> {
    // Atomic $inc upsert on a dedicated counter document. The old
    // MAX(nonce)+1 read let two concurrent creates reserve the same nonce.
    for (let attempt = 0; ; attempt += 1) {
      try {
        const counter = await PayoutNonceCounterModel.findOneAndUpdate(
          { _id: sourceAccount },
          { $inc: { lastNonce: 1 } },
          { upsert: true, new: true }
        );
        return counter.lastNonce;
      } catch (error) {
        const duplicateUpsert =
          typeof error === "object" && error !== null && "code" in error && error.code === 11000;
        if (!duplicateUpsert || attempt >= 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt + 1));
      }
    }
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
      ownerId: record.ownerId ?? null,
      principal: record.principal ?? null,
      yieldAmount: record.yieldAmount ?? null,
      platformFee: record.platformFee ?? null,
      dust: record.dust ?? null,
    });
  }

  async update(
    id: string,
    patch: TransactionPatch
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

  /**
   * Owner-scoped, keyset-paginated payout list for the claim inbox (#1489).
   *
   * Paged in the application rather than with `skip`, because an inbox grows
   * while it is being read: `skip` would make a row shift between pages and
   * return it twice or skip it entirely. The `(updatedAt, id)` keyset is
   * stable against concurrent inserts, which land ahead of an in-flight
   * cursor because they are newer.
   *
   * Requires an index on `{ destinationAccount: 1, updatedAt: -1, _id: -1 }`
   * — without it this is a collection scan of every payout in the database.
   * See the index note in docs/CLAIM_INBOX.md.
   */
  async listByDestination(
    destinationAccount: string,
    limit: number,
    cursor?: { updatedAt: Date; id: string } | null,
  ): Promise<TransactionRecord[]> {
    if (limit <= 0) return [];
    const after = cursor
      ? {
          $or: [
            { updatedAt: { $lt: cursor.updatedAt } },
            { updatedAt: cursor.updatedAt, _id: { $lt: cursor.id } },
          ],
        }
      : {};
    const docs = await TransactionModel.find({ destinationAccount, ...after })
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit);
    return docs.map(docToRecord);
  }
}
