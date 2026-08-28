/**
 * Regression coverage for payout persistence hardening:
 *  - the transactions collection enforces a UNIQUE compound index on
 *    {sourceAccount, nonce} so a lost nonce race fails closed;
 *  - the SQL repository reserves nonces in a single atomic statement and
 *    persists/maps the ownerId column.
 */
import { describe, expect, it } from "@jest/globals";

import { TransactionModel } from "../src/db/models/transaction.model";
import { SqlTransactionRepository, type QueryableDb } from "../src/repositories/sqlTransactionRepository";

describe("TransactionModel unique nonce index", () => {
  it("declares a unique compound index on {sourceAccount: 1, nonce: 1}", () => {
    const indexes = TransactionModel.schema.indexes() as Array<
      [Record<string, number>, Record<string, unknown> | undefined]
    >;

    const match = indexes.find(([spec]) => spec.sourceAccount === 1 && spec.nonce === 1);

    expect(match).toBeDefined();
    expect(match![1]?.unique).toBe(true);
  });
});

class FakeDb implements QueryableDb {
  readonly queries: Array<{ sql: string; params?: unknown[] }> = [];

  constructor(
    private readonly respond: (sql: string) => { rows: unknown[] } = () => ({ rows: [] }),
  ) {}

  async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ sql, params: params ?? [] });
    return this.respond(sql) as { rows: T[] };
  }

  get last() {
    return this.queries[this.queries.length - 1]!;
  }
}

const SOURCE = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

describe("SqlTransactionRepository.reserveNextNonce", () => {
  it("reserves the nonce in a single atomic INSERT ... ON CONFLICT ... RETURNING statement", async () => {
    const db = new FakeDb(() => ({ rows: [{ last_nonce: 7 }] }));

    const nonce = await new SqlTransactionRepository(db).reserveNextNonce(SOURCE);

    expect(nonce).toBe(7);
    expect(db.queries).toHaveLength(1);
    expect(/ON CONFLICT/i.test(db.last.sql)).toBe(true);
    expect(/RETURNING\s+last_nonce/i.test(db.last.sql)).toBe(true);
    // The old MAX(nonce)+1 read is gone — no read-modify-write race window.
    expect(/MAX\(nonce\)/i.test(db.last.sql)).toBe(false);
    expect(db.last.params).toEqual([SOURCE]);
  });
});

function makeRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: "tx-sql-1",
    payout_id: "p-sql-1",
    idempotency_key: "idem-sql-000001",
    source_account: SOURCE,
    destination_account: SOURCE,
    asset: "XLM",
    amount_stroops: "100000000",
    nonce: 3,
    status: "queued",
    unsigned_xdr: "unsigned",
    signed_xdr: null,
    tx_hash: null,
    error_message: null,
    attempts: 0,
    created_at: now,
    updated_at: now,
    confirmed_at: null,
    owner_id: null,
    ...overrides,
  };
}

function makeRecord(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: "tx-sql-2",
    payoutId: "p-sql-2",
    idempotencyKey: "idem-sql-000002",
    sourceAccount: SOURCE,
    destinationAccount: SOURCE,
    asset: "XLM" as const,
    amountStroops: "100000000",
    nonce: 4,
    status: "awaiting_signature" as const,
    unsignedXdr: "unsigned",
    signedXdr: null,
    txHash: null,
    errorMessage: null,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    confirmedAt: null,
    ownerId: null as string | null,
    ...overrides,
  };
}

describe("SqlTransactionRepository owner column", () => {
  it("writes owner_id on insert", async () => {
    const db = new FakeDb();

    await new SqlTransactionRepository(db).insert(makeRecord({ ownerId: "admin-9" }));

    expect(/owner_id/.test(db.last.sql)).toBe(true);
    expect(db.last.params).toContain("admin-9");
  });

  it("maps owner_id to ownerId on reads", async () => {
    const db = new FakeDb((sql) =>
      /WHERE id =/.test(sql)
        ? { rows: [makeRow({ owner_id: "user-42" })] }
        : { rows: [] },
    );

    const record = await new SqlTransactionRepository(db).findById("tx-sql-1");

    expect(record?.ownerId).toBe("user-42");
  });

  it("keeps owner_id stable across status updates", async () => {
    const db = new FakeDb((sql) =>
      /SELECT \*|RETURNING \*/i.test(sql) ? { rows: [makeRow({ owner_id: "user-42" })] } : { rows: [] },
    );

    await new SqlTransactionRepository(db).update("tx-sql-1", {
      status: "submitted",
      txHash: "hash-1",
    });

    expect(/owner_id\s*=/.test(db.last.sql)).toBe(true);
    expect(db.last.params).toContain("user-42");
  });
});
