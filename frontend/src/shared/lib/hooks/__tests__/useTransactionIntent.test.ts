import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { renderHook, act } from "@testing-library/react";
import { Account, Contract, TransactionBuilder } from "@stellar/stellar-sdk";
import { useTransactionIntent } from "../useTransactionIntent";

const PASSPHRASE = "Test SDF Network ; September 2015";
const PUBLIC_KEY = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

function buildTestTransaction() {
  const account = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "1");
  const pool = new Contract("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC");
  const op = pool.call("join_arena");
  return new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(op)
    .setTimeout(30)
    .build();
}

// The hook decodes whatever signTransaction resolves with via
// TransactionBuilder.fromXDR to compute a hash, so mocks must resolve with
// real, decodable XDR rather than an arbitrary string — a fresh unsigned
// envelope's own XDR is valid input for that decode step (the hook only
// reads its hash, it never checks for an actual signature).
const REAL_SIGNED_XDR = buildTestTransaction().toXDR();

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({
    ok,
    json: () => Promise.resolve(body),
  } as Response);
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

describe("useTransactionIntent", () => {
  let fetchMock: jest.Mock<FetchFn>;

  beforeEach(() => {
    fetchMock = jest.fn<FetchFn>();
    global.fetch = fetchMock as unknown as typeof fetch;
    sessionStorage.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("normal path: create -> awaiting-signature -> signed -> outcome, and clears the idempotency key on success", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/transaction-intents")) {
        return jsonResponse({ mode: "created", intent: { id: "intent-1", status: "built" } });
      }
      return jsonResponse({ id: "intent-1", status: "ok" });
    });

    const { result } = renderHook(() => useTransactionIntent());

    const signTransaction = jest.fn<(xdr: string) => Promise<string>>().mockResolvedValue(REAL_SIGNED_XDR);
    const submitSignedTransaction = jest.fn<(signedXdr: string) => Promise<unknown>>().mockResolvedValue({ status: "SUCCESS" });
    const onSigned = jest.fn();

    let outcome: { hash: string } | undefined;
    await act(async () => {
      outcome = await result.current.runTrackedTransaction({
        kind: "join_arena",
        actionKey: "join_arena:arena-1",
        publicKey: PUBLIC_KEY,
        buildTransaction: async () => buildTestTransaction(),
        signTransaction,
        submitSignedTransaction,
        networkPassphrase: PASSPHRASE,
        onSigned,
      });
    });

    expect(outcome?.hash).toEqual(expect.any(String));
    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(submitSignedTransaction).toHaveBeenCalledWith(REAL_SIGNED_XDR);
    expect(onSigned).toHaveBeenCalledTimes(1);

    const urls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(urls.some((u) => u.endsWith("/api/transaction-intents"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/intent-1/awaiting-signature"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/intent-1/signed"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/intent-1/outcome"))).toBe(true);

    // A fresh call for the same actionKey must mint a NEW idempotency key
    // now that the previous one succeeded (its record reached a terminal
    // state and must never be reused for a different action instance).
    const storedKeysAfter = Object.keys(sessionStorage).filter((k) => k.includes("join_arena:arena-1"));
    expect(storedKeysAfter).toHaveLength(0);
  });

  it("wallet rejection: reports signature-failure with reason=rejected, re-throws, and keeps the idempotency key for resume", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/transaction-intents")) {
        return jsonResponse({ mode: "created", intent: { id: "intent-2", status: "built" } });
      }
      return jsonResponse({ id: "intent-2" });
    });

    const { result } = renderHook(() => useTransactionIntent());

    const rejection = new Error("User rejected access");
    const signTransaction = jest.fn<(xdr: string) => Promise<string>>().mockRejectedValue(rejection);
    const submitSignedTransaction = jest.fn<(signedXdr: string) => Promise<unknown>>();

    await act(async () => {
      await expect(
        result.current.runTrackedTransaction({
          kind: "stake",
          actionKey: "stake:5000",
          publicKey: PUBLIC_KEY,
          buildTransaction: async () => buildTestTransaction(),
          signTransaction,
          submitSignedTransaction,
          networkPassphrase: PASSPHRASE,
        })
      ).rejects.toThrow("User rejected access");
    });

    expect(submitSignedTransaction).not.toHaveBeenCalled();

    const failureCall = fetchMock.mock.calls.find((call) =>
      (call[0] as string).endsWith("/intent-2/signature-failure")
    );
    expect(failureCall).toBeDefined();
    const body = JSON.parse((failureCall![1] as RequestInit).body as string);
    expect(body.reason).toBe("rejected");

    // The idempotency key survives a rejection so "Try Again" resumes the
    // same backend record instead of losing track of it (#1381 core
    // criterion).
    const storedKeys = Object.keys(sessionStorage).filter((k) => k.includes("stake:5000"));
    expect(storedKeys).toHaveLength(1);
  });

  it("expired/non-rejection signing failure: reports reason=expired", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/transaction-intents")) {
        return jsonResponse({ mode: "created", intent: { id: "intent-3", status: "built" } });
      }
      return jsonResponse({ id: "intent-3" });
    });

    const { result } = renderHook(() => useTransactionIntent());
    const signTransaction = jest.fn<(xdr: string) => Promise<string>>().mockRejectedValue(new Error("Signing window timed out"));

    await act(async () => {
      await expect(
        result.current.runTrackedTransaction({
          kind: "claim",
          actionKey: "claim:arena-2",
          publicKey: PUBLIC_KEY,
          buildTransaction: async () => buildTestTransaction(),
          signTransaction,
          submitSignedTransaction: jest.fn<(signedXdr: string) => Promise<unknown>>(),
          networkPassphrase: PASSPHRASE,
        })
      ).rejects.toThrow();
    });

    const failureCall = fetchMock.mock.calls.find((call) => (call[0] as string).endsWith("/intent-3/signature-failure"));
    const body = JSON.parse((failureCall![1] as RequestInit).body as string);
    expect(body.reason).toBe("expired");
  });

  it("submission failure: reports outcome status=failed and re-throws", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/transaction-intents")) {
        return jsonResponse({ mode: "created", intent: { id: "intent-4", status: "built" } });
      }
      return jsonResponse({ id: "intent-4" });
    });

    const { result } = renderHook(() => useTransactionIntent());
    const signTransaction = jest.fn<(xdr: string) => Promise<string>>().mockResolvedValue(REAL_SIGNED_XDR);
    const submissionError = new Error("Soroban rejected transaction");
    const submitSignedTransaction = jest
      .fn<(signedXdr: string) => Promise<unknown>>()
      .mockRejectedValue(submissionError);

    await act(async () => {
      await expect(
        result.current.runTrackedTransaction({
          kind: "unstake",
          actionKey: "unstake:100",
          publicKey: PUBLIC_KEY,
          buildTransaction: async () => buildTestTransaction(),
          signTransaction,
          submitSignedTransaction,
          networkPassphrase: PASSPHRASE,
        })
      ).rejects.toThrow("Soroban rejected transaction");
    });

    const outcomeCall = fetchMock.mock.calls.find((call) => (call[0] as string).endsWith("/intent-4/outcome"));
    expect(outcomeCall).toBeDefined();
    const body = JSON.parse((outcomeCall![1] as RequestInit).body as string);
    expect(body.status).toBe("failed");
    expect(body.errorMessage).toBe("Soroban rejected transaction");
  });

  it("resumes the same idempotency key across two calls with the same actionKey+wallet (boundary: retry after failure)", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/transaction-intents")) {
        return jsonResponse({ mode: "created", intent: { id: "intent-5", status: "built" } });
      }
      return jsonResponse({ id: "intent-5" });
    });

    const { result } = renderHook(() => useTransactionIntent());
    const signTransaction = jest.fn<(xdr: string) => Promise<string>>().mockRejectedValue(new Error("User rejected access"));

    await act(async () => {
      await expect(
        result.current.runTrackedTransaction({
          kind: "commit_choice",
          actionKey: "commit_choice:arena-3:round-1",
          publicKey: PUBLIC_KEY,
          buildTransaction: async () => buildTestTransaction(),
          signTransaction,
          submitSignedTransaction: jest.fn<(signedXdr: string) => Promise<unknown>>(),
          networkPassphrase: PASSPHRASE,
        })
      ).rejects.toThrow();
    });

    const firstCreateCall = fetchMock.mock.calls.find((call) => (call[0] as string).endsWith("/api/transaction-intents"));
    const firstKey = JSON.parse((firstCreateCall![1] as RequestInit).body as string).idempotencyKey;

    await act(async () => {
      await expect(
        result.current.runTrackedTransaction({
          kind: "commit_choice",
          actionKey: "commit_choice:arena-3:round-1",
          publicKey: PUBLIC_KEY,
          buildTransaction: async () => buildTestTransaction(),
          signTransaction,
          submitSignedTransaction: jest.fn<(signedXdr: string) => Promise<unknown>>(),
          networkPassphrase: PASSPHRASE,
        })
      ).rejects.toThrow();
    });

    const createCalls = fetchMock.mock.calls.filter((call) => (call[0] as string).endsWith("/api/transaction-intents"));
    expect(createCalls).toHaveLength(2);
    const secondKey = JSON.parse((createCalls[1]![1] as RequestInit).body as string).idempotencyKey;
    expect(secondKey).toBe(firstKey);
  });

  it("does not block the wallet flow when the intents API is unreachable (invalid-input / network-failure path)", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useTransactionIntent());
    const signTransaction = jest.fn<(xdr: string) => Promise<string>>().mockResolvedValue(REAL_SIGNED_XDR);
    const submitSignedTransaction = jest.fn<(signedXdr: string) => Promise<unknown>>().mockResolvedValue({ status: "SUCCESS" });

    let outcome: { hash: string } | undefined;
    await act(async () => {
      outcome = await result.current.runTrackedTransaction({
        kind: "reveal_choice",
        actionKey: "reveal_choice:arena-4:round-1",
        publicKey: PUBLIC_KEY,
        buildTransaction: async () => buildTestTransaction(),
        signTransaction,
        submitSignedTransaction,
        networkPassphrase: PASSPHRASE,
      });
    });

    expect(outcome?.hash).toEqual(expect.any(String));
    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(submitSignedTransaction).toHaveBeenCalledTimes(1);
  });
});
