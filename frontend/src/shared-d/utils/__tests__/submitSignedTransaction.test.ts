/**
 * Tests for submitSignedTransaction's timeout-vs-failure handling (#1135).
 *
 * Previously, a poll loop that exhausted while the transaction was still
 * NOT_FOUND on Soroban RPC threw TRANSACTION_FAILED — indistinguishable
 * from a genuine on-chain failure, even though the transaction might still
 * confirm moments later. It must now throw TRANSACTION_TIMEOUT (carrying
 * the hash) for "still unknown," and reserve TRANSACTION_FAILED for an
 * actual terminal failure status.
 */
const mockSendTransaction = jest.fn();
const mockGetTransaction = jest.fn();

jest.mock("@stellar/stellar-sdk/rpc", () => ({
  Server: jest.fn().mockImplementation(() => ({
    sendTransaction: mockSendTransaction,
    getTransaction: mockGetTransaction,
  })),
}));

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    TransactionBuilder: {
      ...actual.TransactionBuilder,
      fromXDR: jest.fn().mockReturnValue({}),
    },
  };
});

jest.mock("@/shared-d/utils/stellar-fee-estimator", () => ({
  ...jest.requireActual("@/shared-d/utils/stellar-fee-estimator"),
  getSubmitRetryConfig: () => ({ maxRetries: 3, retryIntervalMs: 1 }),
}));

import {
  submitSignedTransaction,
  checkTransactionOnHorizon,
  reconcilePendingTransaction,
} from "../stellar-transactions";
import { ContractError, ContractErrorCode } from "@/shared-d/utils/contract-error";

const VALID_XDR = "A".repeat(30);
const HASH = "deadbeef00112233";

describe("submitSignedTransaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the confirmed response when the transaction succeeds", async () => {
    mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: HASH });
    mockGetTransaction.mockResolvedValue({ status: "SUCCESS", hash: HASH });

    const result = await submitSignedTransaction(VALID_XDR);

    expect(result.status).toBe("SUCCESS");
  });

  it("throws TRANSACTION_TIMEOUT (not TRANSACTION_FAILED) with the hash when polling exhausts while still NOT_FOUND", async () => {
    mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: HASH });
    mockGetTransaction.mockResolvedValue({ status: "NOT_FOUND" });

    await expect(submitSignedTransaction(VALID_XDR)).rejects.toMatchObject({
      code: ContractErrorCode.TRANSACTION_TIMEOUT,
      hash: HASH,
    });
  });

  it("includes the hash in the timeout message so it can be checked manually", async () => {
    mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: HASH });
    mockGetTransaction.mockResolvedValue({ status: "NOT_FOUND" });

    try {
      await submitSignedTransaction(VALID_XDR);
      throw new Error("expected submitSignedTransaction to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      expect((error as ContractError).message).toContain(HASH);
    }
  });

  it("throws TRANSACTION_TIMEOUT when every poll attempt throws (network failure)", async () => {
    mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: HASH });
    mockGetTransaction.mockRejectedValue(new Error("network blip"));

    await expect(submitSignedTransaction(VALID_XDR)).rejects.toMatchObject({
      code: ContractErrorCode.TRANSACTION_TIMEOUT,
      hash: HASH,
    });
  });

  it("still throws TRANSACTION_FAILED for a genuine terminal failure status", async () => {
    mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: HASH });
    mockGetTransaction.mockResolvedValue({ status: "FAILED" });

    await expect(submitSignedTransaction(VALID_XDR)).rejects.toMatchObject({
      code: ContractErrorCode.TRANSACTION_FAILED,
      hash: HASH,
    });
  });

  it("still throws TRANSACTION_FAILED when the network rejects the initial submission", async () => {
    mockSendTransaction.mockResolvedValue({ status: "ERROR", hash: HASH });

    await expect(submitSignedTransaction(VALID_XDR)).rejects.toMatchObject({
      code: ContractErrorCode.TRANSACTION_FAILED,
    });
    expect(mockGetTransaction).not.toHaveBeenCalled();
  });
});

describe("checkTransactionOnHorizon", () => {
  it("reports SUCCESS for a successful transaction", async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ successful: true }),
    });

    const result = await checkTransactionOnHorizon(HASH, "https://horizon.example", fetchFn);

    expect(result).toEqual({ hash: HASH, status: "SUCCESS" });
    expect(fetchFn).toHaveBeenCalledWith("https://horizon.example/transactions/deadbeef00112233");
  });

  it("reports FAILED for an unsuccessful transaction", async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ successful: false }),
    });

    const result = await checkTransactionOnHorizon(HASH, "https://horizon.example", fetchFn);

    expect(result).toEqual({ hash: HASH, status: "FAILED" });
  });

  it("reports NOT_FOUND on a 404 instead of throwing", async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 404 });

    const result = await checkTransactionOnHorizon(HASH, "https://horizon.example", fetchFn);

    expect(result).toEqual({ hash: HASH, status: "NOT_FOUND" });
  });

  it("throws a ContractError on an unexpected non-404 error response", async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 500 });

    await expect(
      checkTransactionOnHorizon(HASH, "https://horizon.example", fetchFn),
    ).rejects.toBeInstanceOf(ContractError);
  });
});

describe("reconcilePendingTransaction", () => {
  it("resolves as soon as Horizon reports a terminal status", async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ successful: true }) });

    const result = await reconcilePendingTransaction(HASH, {
      horizonBaseUrl: "https://horizon.example",
      intervalMs: 1,
      maxAttempts: 5,
      fetchFn,
    });

    expect(result).toEqual({ hash: HASH, status: "SUCCESS" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts and returns NOT_FOUND rather than throwing", async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 404 });

    const result = await reconcilePendingTransaction(HASH, {
      horizonBaseUrl: "https://horizon.example",
      intervalMs: 1,
      maxAttempts: 3,
      fetchFn,
    });

    expect(result).toEqual({ hash: HASH, status: "NOT_FOUND" });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("treats a fetch-level error as NOT_FOUND for that attempt and keeps retrying", async () => {
    const fetchFn = jest
      .fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ successful: true }) });

    const result = await reconcilePendingTransaction(HASH, {
      horizonBaseUrl: "https://horizon.example",
      intervalMs: 1,
      maxAttempts: 5,
      fetchFn,
    });

    expect(result).toEqual({ hash: HASH, status: "SUCCESS" });
  });
});
