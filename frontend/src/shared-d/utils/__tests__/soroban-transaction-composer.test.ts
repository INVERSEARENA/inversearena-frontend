import { describe, it, expect } from "@jest/globals";
import { Account, Contract } from "@stellar/stellar-sdk";
import {
  buildJoinCallOperation,
  buildStakeCallOperation,
  buildUnstakeCallOperation,
  composeUnsignedTransaction,
  roundSpeedToSeconds,
  buildCreatePoolCallOperation,
} from "../soroban-transaction-composer";

const VALID_CONTRACT =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

describe("soroban-transaction-composer", () => {
  it("roundSpeedToSeconds maps enum values", () => {
    expect(roundSpeedToSeconds("30S")).toBe(30);
    expect(roundSpeedToSeconds("1M")).toBe(60);
    expect(roundSpeedToSeconds("5M")).toBe(300);
  });

  it("composeUnsignedTransaction produces an XDR-backed transaction", () => {
    const account = new Account(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      "1",
    );
    const pool = new Contract(VALID_CONTRACT);
    const op = buildJoinCallOperation(pool);

    const tx = composeUnsignedTransaction(account, {
      fee: "100",
      networkPassphrase: "Test SDF Network ; September 2015",
      timeout: 30,
      operation: op,
    });

    expect(tx.operations.length).toBe(1);
  });

  it("buildCreatePoolCallOperation returns an invoke operation", () => {
    const factory = new Contract(VALID_CONTRACT);
    const op = buildCreatePoolCallOperation(
      factory,
      {
        stakeAmount: 1,
        currency: "XLM",
        roundSpeed: "30S",
        arenaCapacity: 8,
      },
      {
        xlmContractId: VALID_CONTRACT,
        usdcContractId: VALID_CONTRACT,
      },
    );

    expect(op).toBeDefined();
    expect(typeof (op as { body?: unknown }).body).toBe("function");
  });

  it("buildStakeCallOperation returns an invoke operation", () => {
    const staking = new Contract(VALID_CONTRACT);
    const op = buildStakeCallOperation(
      staking,
      BigInt(250_000_000),
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );

    expect(op).toBeDefined();
    expect(typeof (op as { body?: unknown }).body).toBe("function");
  });

  it("buildUnstakeCallOperation returns an invoke operation", () => {
    const staking = new Contract(VALID_CONTRACT);
    const op = buildUnstakeCallOperation(
      staking,
      BigInt(125_000_000),
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );

    expect(op).toBeDefined();
    expect(typeof (op as { body?: unknown }).body).toBe("function");
  });

  it("buildUnstakeCallOperation accepts zero-value bigint without throwing", () => {
    const staking = new Contract(VALID_CONTRACT);
    // The composer layer doesn't validate amounts — that's the contract's job.
    const op = buildUnstakeCallOperation(
      staking,
      BigInt(0),
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );

    expect(op).toBeDefined();
  });
});
