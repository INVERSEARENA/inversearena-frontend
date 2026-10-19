/**
 * Regression coverage for payout persistence hardening:
 *  - the transactions collection enforces a UNIQUE compound index on
 *    {sourceAccount, nonce} so a lost nonce race fails closed.
 */
import { describe, expect, it } from "@jest/globals";

import { TransactionModel } from "../src/db/models/transaction.model";

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
