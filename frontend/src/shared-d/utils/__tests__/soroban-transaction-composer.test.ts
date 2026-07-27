import { describe, it, expect } from "@jest/globals";
import { Account, Contract, type Operation, type xdr } from "@stellar/stellar-sdk";
import {
  buildJoinCallOperation,
  buildRevealChoiceOperation,
  buildSubmitCommitmentOperation,
  composeUnsignedTransaction,
  roundSpeedToSeconds,
  buildCreatePoolCallOperation,
} from "../soroban-transaction-composer";

const VALID_CONTRACT =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const VALID_PUBLIC_KEY =
  "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

function invokedFunction(op: Operation) {
  return (op as unknown as { body: () => xdr.OperationBody })
    .body()
    .invokeHostFunctionOp()
    .hostFunction()
    .invokeContract();
}

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

  describe("commit-reveal operations (#1137)", () => {
    const pool = new Contract(VALID_CONTRACT);

    it("buildSubmitCommitmentOperation invokes submit_commitment with (player, commitment)", () => {
      const commitment = new Uint8Array(32).fill(9);
      const op = buildSubmitCommitmentOperation(pool, VALID_PUBLIC_KEY, commitment);

      const invoked = invokedFunction(op);
      expect(invoked.functionName().toString()).toBe("submit_commitment");
      expect(invoked.args()).toHaveLength(2);
      expect(invoked.args()[1]!.bytes().equals(Buffer.from(commitment))).toBe(true);
    });

    it("buildSubmitCommitmentOperation rejects a commitment that isn't 32 bytes", () => {
      expect(() =>
        buildSubmitCommitmentOperation(pool, VALID_PUBLIC_KEY, new Uint8Array(16)),
      ).toThrow(/32 bytes/);
    });

    it("buildRevealChoiceOperation invokes reveal_choice with (player, choice, salt)", () => {
      const salt = new Uint8Array(32).fill(3);
      const op = buildRevealChoiceOperation(pool, VALID_PUBLIC_KEY, "Tails", salt);

      const invoked = invokedFunction(op);
      expect(invoked.functionName().toString()).toBe("reveal_choice");
      expect(invoked.args()).toHaveLength(3);
      expect(invoked.args()[1]!.sym().toString()).toBe("Tails");
      expect(invoked.args()[2]!.bytes().equals(Buffer.from(salt))).toBe(true);
    });

    it("buildRevealChoiceOperation rejects a salt that isn't 32 bytes", () => {
      expect(() =>
        buildRevealChoiceOperation(pool, VALID_PUBLIC_KEY, "Heads", new Uint8Array(31)),
      ).toThrow(/32 bytes/);
    });
  });
});
