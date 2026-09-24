/**
 * Cross-module integration test for deterministic client reconciliation
 * (#1385).
 *
 * Drives the real boundary: submitSignedTransaction (mocked RPC Server) →
 * captureTransactionOutcome → reconcileTransaction (mocked Horizon) →
 * useArenaState.reconcile (fetchArenaState stubbed as the chain-read seam).
 * Verifies that optimistic state converges to chain state after SUCCESS,
 * REJECTED, and TIMEOUT outcomes — the acceptance criterion for the issue.
 */
import {
  renderHook,
  waitFor,
  act,
} from "@testing-library/react";
import { useArenaState } from "../useArenaState";
import type { ArenaStateResponse } from "@/shared-d/utils/stellar-transactions";
import {
  submitSignedTransaction,
  captureTransactionOutcome,
  reconcileTransaction,
} from "@/shared-d/utils/stellar-transactions";
import { ContractErrorCode } from "@/shared-d/utils/contract-error";
import type { TransactionOutcome } from "@/shared-d/utils/stellar-transactions";

const mockSendTransaction = jest.fn();
const mockGetTransaction = jest.fn();
const mockFetchArenaState = jest.fn();

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

// Keep the real engine + submit path; the only chain-read seam is fetchArenaState.
jest.mock("@/shared-d/utils/stellar-transactions", () => ({
  ...jest.requireActual("@/shared-d/utils/stellar-transactions"),
  fetchArenaState: (...args: unknown[]) => mockFetchArenaState(...args),
}));

const ARENA_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const USER_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function baseResponse(overrides: Partial<ArenaStateResponse> = {}): ArenaStateResponse {
  return {
    arenaId: ARENA_ID,
    survivorsCount: 7,
    maxCapacity: 10,
    isUserIn: false,
    hasWon: false,
    currentStake: 100,
    potentialPayout: 250,
    roundNumber: 2,
    gameState: 1,
    entryFee: 100,
    playerCount: 7,
    commitDeadline: null,
    revealDeadline: null,
    ...overrides,
  };
}

const VALID_XDR = "A".repeat(30);
const longHash = (seed: string): string =>
  Buffer.from(seed + seed).toString("hex").padEnd(64, "0").slice(0, 64);

describe("client reconciliation integration (#1385)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchArenaState.mockResolvedValue(baseResponse());
  });

  it("converges optimistic state to chain state after SUCCESS", async () => {
    const hash = longHash("success");
    mockSendTransaction.mockResolvedValue({ status: "PENDING", hash });
    mockGetTransaction.mockResolvedValue({
      status: "SUCCESS",
      txHash: hash,
      ledger: 1,
      createdAt: 1,
      applicationOrder: 1,
      feeBump: false,
      events: [],
    });
    const horizonFetch = jest
      .fn()
      .mockRejectedValue(new Error("Horizon must not be reached for SUCCESS"));
    const { result, unmount } = renderHook(() => useArenaState(ARENA_ID));

    // Pre-join optimistic view (not yet on-chain).
    mockFetchArenaState.mockResolvedValue(
      baseResponse({ isUserIn: false }),
    );
    await waitFor(() => expect(result.current.state).not.toBeNull());
    expect(result.current.state?.isUserIn).toBe(false);

    // 1. Submit + confirm via Soroban RPC.
    const txResult = await submitSignedTransaction(VALID_XDR);
    expect(txResult.status).toBe("SUCCESS");

    // 2. Deterministic reconciliation: SUCCESS is already confirmed.
    const reconciled = await reconcileTransaction(
      { status: "SUCCESS", hash: String(txResult.txHash) },
      { fetchFn: horizonFetch, arenaId: ARENA_ID },
    );
    expect(reconciled.resolved).toBe("CONFIRMED");
    expect(reconciled.source).toBe("rpc");

    // 3. Converge the UI: chain now shows this wallet joined.
    mockFetchArenaState.mockResolvedValue(
      baseResponse({ isUserIn: true }),
    );
    await act(async () => {
      await result.current.reconcile(USER_KEY);
    });
    expect(result.current.state?.isUserIn).toBe(true);
    expect(horizonFetch).not.toHaveBeenCalled();
    unmount();
  });

  it("converges optimistic state to chain state after REJECTED", async () => {
    const hash = longHash("rejected");
    mockSendTransaction.mockResolvedValue({ status: "ERROR", hash });
    const { result, unmount } = renderHook(() => useArenaState(ARENA_ID));
    await waitFor(() => expect(result.current.state?.isUserIn).toBe(false));

    // 1. Submit is rejected by the network.
    let outcome: TransactionOutcome | null = null;
    try {
      await submitSignedTransaction(VALID_XDR);
    } catch (error) {
      outcome = captureTransactionOutcome(error);
    }
    expect(outcome).toMatchObject({
      status: "REJECTED",
      reason: ContractErrorCode.TRANSACTION_FAILED,
    });

    // 2. Reconciliation resolves REJECTED deterministically — no Horizon work.
    const reconciled = await reconcileTransaction(outcome!, {
      fetchFn: jest
        .fn()
        .mockRejectedValue(new Error("no retry for a terminal rejection")),
      arenaId: ARENA_ID,
    });
    expect(reconciled.resolved).toBe("REJECTED");
    expect(reconciled.source).toBe("rpc");

    // 3. Chain state is the authority: the join never landed, so isUserIn stays false.
    await act(async () => {
      await result.current.reconcile(USER_KEY);
    });
    expect(result.current.state?.isUserIn).toBe(false);
    expect(result.current.state?.survivorsCount).toBe(7);
    unmount();
  });

  it("converges optimistic state to chain state after TIMEOUT resolves on Horizon", async () => {
    const hash = longHash("timeout");
    mockSendTransaction.mockResolvedValue({ status: "PENDING", hash });
    mockGetTransaction.mockResolvedValue({ status: "NOT_FOUND" });
    const { result, unmount } = renderHook(() => useArenaState(ARENA_ID));
    await waitFor(() => expect(result.current.state?.isUserIn).toBe(false));

    // 1. RPC polling exhausts while the tx is still NOT_FOUND -> TRANSACTION_TIMEOUT.
    let outcome: TransactionOutcome | null = null;
    try {
      await submitSignedTransaction(VALID_XDR);
    } catch (error) {
      outcome = captureTransactionOutcome(error);
    }
    expect(outcome).toMatchObject({ status: "TIMEOUT", hash });

    // 2. Deterministic reconciliation retries via Horizon until it confirms.
    const horizonFetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ successful: true }),
      });
    const reconciled = await reconcileTransaction(
      outcome as Extract<TransactionOutcome, { status: "TIMEOUT" }>,
      { fetchFn: horizonFetch, intervalMs: 1, maxAttempts: 3, arenaId: ARENA_ID },
    );
    expect(reconciled.resolved).toBe("CONFIRMED");
    expect(reconciled.source).toBe("horizon");
    expect(reconciled.retries).toBeGreaterThanOrEqual(1);

    // 3. Converge the UI once the timeout is reconciled to CONFIRMED.
    mockFetchArenaState.mockResolvedValue(
      baseResponse({ isUserIn: true }),
    );
    await act(async () => {
      await result.current.reconcile(USER_KEY);
    });
    expect(result.current.state?.isUserIn).toBe(true);
    unmount();
  });
});