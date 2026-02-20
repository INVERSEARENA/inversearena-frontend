import type { PaymentStatus, TransactionRecord } from "../types/payment";
import type { TransactionRepository } from "./transactionRepository";

export interface QueryableDb {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

type TransactionRow = {
  id: string;
  payout_id: string;
  idempotency_key: string;
  source_account: string;
  destination_account: string;
  asset: "XLM" | "USDC";
  amount_stroops: string;
  nonce: number;
  status: PaymentStatus;
  unsigned_xdr: string;
  signed_xdr: string | null;
  tx_hash: string | null;
  error_message: string | null;
  attempts: number;
  created_at: Date | string;
  updated_at: Date | string;
  confirmed_at: Date | string | null;
};

function mapRow(row: TransactionRow): TransactionRecord {
  return {
    id: row.id,
    payoutId: row.payout_id,
    idempotencyKey: row.idempotency_key,
    sourceAccount: row.source_account,
    destinationAccount: row.destination_account,
    asset: row.asset,
    amountStroops: row.amount_stroops,
    nonce: Number(row.nonce),
    status: row.status,
    unsignedXdr: row.unsigned_xdr,
    signedXdr: row.signed_xdr,
    txHash: row.tx_hash,
    errorMessage: row.error_message,
    attempts: Number(row.attempts),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : null,
  };
}

export class SqlTransactionRepository implements TransactionRepository {
  constructor(private readonly db: QueryableDb) {}

  async findByIdempotencyKey(idempotencyKey: string): Promise<TransactionRecord | null> {
    const result = await this.db.query<TransactionRow>(
      "SELECT * FROM transactions WHERE idempotency_key = $1 LIMIT 1",
      [idempotencyKey]
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]);
  }

  async findById(id: string): Promise<TransactionRecord | null> {
    const result = await this.db.query<TransactionRow>(
      "SELECT * FROM transactions WHERE id = $1 LIMIT 1",
      [id]
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]);
  }

  async reserveNextNonce(sourceAccount: string): Promise<number> {
    const result = await this.db.query<{ nonce: number }>(
      "SELECT COALESCE(MAX(nonce), 0) + 1 AS nonce FROM transactions WHERE source_account = $1",
      [sourceAccount]
    );
    return Number(result.rows[0]?.nonce ?? 1);
  }

  async insert(record: TransactionRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO transactions (
        id, payout_id, idempotency_key, source_account, destination_account, asset,
        amount_stroops, nonce, status, unsigned_xdr, signed_xdr, tx_hash, error_message,
        attempts, created_at, updated_at, confirmed_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17
      )`,
      [
        record.id,
        record.payoutId,
        record.idempotencyKey,
        record.sourceAccount,
        record.destinationAccount,
        record.asset,
        record.amountStroops,
        record.nonce,
        record.status,
        record.unsignedXdr,
        record.signedXdr ?? null,
        record.txHash ?? null,
        record.errorMessage ?? null,
        record.attempts,
        record.createdAt,
        record.updatedAt,
        record.confirmedAt ?? null,
      ]
    );
  }

  async update(
    id: string,
    patch: Partial<Omit<TransactionRecord, "id" | "createdAt">>
  ): Promise<TransactionRecord> {
    const current = await this.findById(id);
    if (!current) {
      throw new Error(`Transaction ${id} not found`);
    }

    const updated: TransactionRecord = {
      ...current,
      ...patch,
      updatedAt: new Date(),
    };

    await this.db.query(
      `UPDATE transactions SET
        payout_id = $2,
        idempotency_key = $3,
        source_account = $4,
        destination_account = $5,
        asset = $6,
        amount_stroops = $7,
        nonce = $8,
        status = $9,
        unsigned_xdr = $10,
        signed_xdr = $11,
        tx_hash = $12,
        error_message = $13,
        attempts = $14,
        updated_at = $15,
        confirmed_at = $16
      WHERE id = $1`,
      [
        updated.id,
        updated.payoutId,
        updated.idempotencyKey,
        updated.sourceAccount,
        updated.destinationAccount,
        updated.asset,
        updated.amountStroops,
        updated.nonce,
        updated.status,
        updated.unsignedXdr,
        updated.signedXdr ?? null,
        updated.txHash ?? null,
        updated.errorMessage ?? null,
        updated.attempts,
        updated.updatedAt,
        updated.confirmedAt ?? null,
      ]
    );

    return updated;
  }

  async listByStatus(statuses: PaymentStatus[], limit: number): Promise<TransactionRecord[]> {
    if (statuses.length === 0 || limit <= 0) {
      return [];
    }

    const placeholders = statuses.map((_, index) => `$${index + 1}`).join(", ");
    const result = await this.db.query<TransactionRow>(
      `SELECT * FROM transactions
       WHERE status IN (${placeholders})
       ORDER BY created_at ASC
       LIMIT $${statuses.length + 1}`,
      [...statuses, limit]
    );
    return result.rows.map(mapRow);
  }
}

