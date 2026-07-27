/**
 * Tests for the commit/reveal transaction-building orchestration (#1137):
 * buildSubmitCommitmentTransaction, buildRevealChoiceTransaction, and the
 * localStorage helpers re-exported alongside them.
 */
import {
  buildSubmitCommitmentTransaction,
  buildRevealChoiceTransaction,
  clearCommitmentForRound,
  hasStoredCommitmentForRound,
} from "../stellar-transactions";
import { loadCommitment } from "../commit-reveal";
import { ContractError, ContractErrorCode } from "@/shared-d/utils/contract-error";

const PUBLIC_KEY = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const POOL_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function mockHorizonAccountFetch() {
  return jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ sequence: "1" }),
  });
}

describe("buildSubmitCommitmentTransaction", () => {
  beforeEach(() => {
    localStorage.clear();
    (global.fetch as unknown) = mockHorizonAccountFetch();
  });

  it("builds a transaction with a single operation", async () => {
    const tx = await buildSubmitCommitmentTransaction(PUBLIC_KEY, POOL_ID, "Heads", 3);
    expect(tx.operations.length).toBe(1);
  });

  it("saves the choice and a freshly generated salt to localStorage keyed by pool + round", async () => {
    await buildSubmitCommitmentTransaction(PUBLIC_KEY, POOL_ID, "Tails", 5);

    const stored = loadCommitment(POOL_ID, 5);
    expect(stored).not.toBeNull();
    expect(stored!.choice).toBe("Tails");
    expect(stored!.salt.length).toBe(32);
  });

  it("invokes submit_commitment (the choice never appears — only its hash does)", async () => {
    const tx = await buildSubmitCommitmentTransaction(PUBLIC_KEY, POOL_ID, "Heads", 1);
    const op = tx.operations[0] as unknown as {
      func: { invokeContract: () => { functionName: () => { toString: () => string } } };
    };
    expect(op.func.invokeContract().functionName().toString()).toBe("submit_commitment");
  });
});

describe("buildRevealChoiceTransaction", () => {
  beforeEach(() => {
    localStorage.clear();
    (global.fetch as unknown) = mockHorizonAccountFetch();
  });

  it("builds a reveal transaction using the choice/salt saved during commit", async () => {
    await buildSubmitCommitmentTransaction(PUBLIC_KEY, POOL_ID, "Heads", 7);

    const tx = await buildRevealChoiceTransaction(PUBLIC_KEY, POOL_ID, 7);
    expect(tx.operations.length).toBe(1);

    const op = tx.operations[0] as unknown as {
      func: { invokeContract: () => { functionName: () => { toString: () => string } } };
    };
    expect(op.func.invokeContract().functionName().toString()).toBe("reveal_choice");
  });

  it("throws VALIDATION_FAILED when nothing was committed for that round on this device", async () => {
    await expect(buildRevealChoiceTransaction(PUBLIC_KEY, POOL_ID, 999)).rejects.toMatchObject({
      code: ContractErrorCode.VALIDATION_FAILED,
    });
  });

  it("throws a ContractError instance (not a raw Error) when nothing was committed", async () => {
    await expect(buildRevealChoiceTransaction(PUBLIC_KEY, POOL_ID, 999)).rejects.toBeInstanceOf(
      ContractError,
    );
  });
});

describe("clearCommitmentForRound / hasStoredCommitmentForRound", () => {
  beforeEach(() => {
    localStorage.clear();
    (global.fetch as unknown) = mockHorizonAccountFetch();
  });

  it("hasStoredCommitmentForRound reflects whether a commitment was saved", async () => {
    expect(hasStoredCommitmentForRound(POOL_ID, 2)).toBe(false);

    await buildSubmitCommitmentTransaction(PUBLIC_KEY, POOL_ID, "Heads", 2);

    expect(hasStoredCommitmentForRound(POOL_ID, 2)).toBe(true);
  });

  it("clearCommitmentForRound removes the stored commitment", async () => {
    await buildSubmitCommitmentTransaction(PUBLIC_KEY, POOL_ID, "Heads", 2);
    expect(hasStoredCommitmentForRound(POOL_ID, 2)).toBe(true);

    clearCommitmentForRound(POOL_ID, 2);

    expect(hasStoredCommitmentForRound(POOL_ID, 2)).toBe(false);
  });
});
