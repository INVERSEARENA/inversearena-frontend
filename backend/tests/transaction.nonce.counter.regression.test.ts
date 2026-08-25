/**
 * Regression coverage for atomic payout nonce reservation (#nonce-race):
 *  - Mongo reservation must use an atomic counter document ($inc upsert),
 *    never a MAX(nonce)+1 read that two concurrent creates can win together.
 *  - ownerId must round-trip through the Mongo repository.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../src/db/models/transaction.model", () => {
  const create = jest.fn();
  const findById = jest.fn();
  return { TransactionModel: { create, findById } };
});

jest.mock("../src/db/models/payoutNonceCounter.model", () => {
  const findOneAndUpdate = jest.fn();
  return { PayoutNonceCounterModel: { findOneAndUpdate } };
});

import { PayoutNonceCounterModel } from "../src/db/models/payoutNonceCounter.model";
import { TransactionModel } from "../src/db/models/transaction.model";
import { MongoTransactionRepository } from "../src/repositories/mongoTransactionRepository";

const findOneAndUpdate = PayoutNonceCounterModel.findOneAndUpdate as unknown as jest.Mock;
const txCreate = TransactionModel.create as unknown as jest.Mock;
const txFindById = TransactionModel.findById as unknown as jest.Mock;

function makeRecord(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: "tx-mongo-1",
    payoutId: "p-1",
    idempotencyKey: "idem-mongo-0001",
    sourceAccount: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
    destinationAccount: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
    asset: "XLM" as const,
    amountStroops: "100000000",
    nonce: 1,
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

beforeEach(() => {
  findOneAndUpdate.mockReset();
  txCreate.mockReset();
  txFindById.mockReset();
});

describe("MongoTransactionRepository.reserveNextNonce", () => {
  it("reserves nonces atomically via $inc upsert on the counter document", async () => {
    findOneAndUpdate.mockResolvedValue({ lastNonce: 42 });

    const repo = new MongoTransactionRepository();
    const nonce = await repo.reserveNextNonce("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H");

    expect(nonce).toBe(42);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H" },
      { $inc: { lastNonce: 1 } },
      { upsert: true, new: true },
    );
  });
});

describe("MongoTransactionRepository owner persistence", () => {
  it("persists ownerId on insert", async () => {
    txCreate.mockResolvedValue({});
    const record = makeRecord({ ownerId: "admin-1" });

    await new MongoTransactionRepository().insert(record);

    expect(txCreate).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "admin-1" }));
  });

  it("maps ownerId when reading documents", async () => {
    const obj = makeRecord({ ownerId: "user-9", _id: "tx-mongo-1", id: undefined });
    delete (obj as { id?: string }).id;
    txFindById.mockResolvedValue({ toObject: () => ({ ...obj }) });

    const record = await new MongoTransactionRepository().findById("tx-mongo-1");

    expect(record?.ownerId).toBe("user-9");
  });
});
