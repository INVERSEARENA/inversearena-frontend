"use client";

/**
 * useTransactionFlow — issue #1606
 *
 * Owns the full lifecycle of a Soroban transaction:
 *   prepare → awaiting-signature → submitted → confirmed | failed
 *
 * Feature modals only supply:
 *   • A `builder` function that resolves to an unsigned XDR string.
 *   • Optional callbacks for success / failure.
 *
 * Design goals:
 *   - Typed failure reasons so UI can render contextually.
 *   - Consistent retry semantics across all modals.
 *   - Modal-close-mid-flow continues in the background; a toast notifies.
 *   - Explorer link surfaced on confirmed or failed (hash known).
 */

import { useState, useCallback, useRef } from "react";
import { parseStellarError } from "@/shared-d/utils/stellar-transactions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Every distinct cause of transaction failure that the UI renders differently. */
export type TransactionFailureReason =
  | "user_rejected"
  | "simulation_failed"
  | "submission_failed"
  | "timeout"
  | "unknown";

export type TransactionFlowStage =
  | "idle"
  | "preparing"
  | "awaiting_signature"
  | "submitted"
  | "confirmed"
  | "failed";

export interface TransactionFlowState {
  stage: TransactionFlowStage;
  /** Set once the transaction hash is known (after submission). */
  txHash: string | null;
  /** Set when the flow ends in failure. */
  failureReason: TransactionFailureReason | null;
  /** Human-readable error detail; may be empty when reason is self-explanatory. */
  errorDetail: string | null;
  /** Stellar expert explorer link — available as soon as txHash is set. */
  explorerUrl: string | null;
}

export interface TransactionFlowActions {
  /** Start the flow. Calling while not idle is a no-op. */
  run: () => Promise<void>;
  /** Reset back to idle (allows retry or clean close). */
  reset: () => void;
}

export type UseTransactionFlowResult = TransactionFlowState & TransactionFlowActions;

/**
 * Options passed to useTransactionFlow.
 *
 * @param builder  Async function that builds the unsigned XDR. Throwing with
 *                 `{ code: "SimulationFailed" }` surfaces as `simulation_failed`.
 * @param sign     Async function that signs the XDR. Throwing with a
 *                 cancellation signal surfaces as `user_rejected`.
 * @param submit   Async function that submits signed XDR; resolves to txHash.
 * @param confirm  Optional polling function; resolves when on-chain.
 * @param onSuccess Called after confirmed.
 * @param onFailure Called after any terminal failure.
 * @param network  Stellar network for explorer URLs (`"testnet"` | `"mainnet"`).
 * @param timeoutMs Milliseconds before a submitted-but-unconfirmed tx is timed out.
 */
export interface UseTransactionFlowOptions {
  builder: () => Promise<string>;
  sign: (xdr: string) => Promise<string>;
  submit: (signedXdr: string) => Promise<string>;
  confirm?: (txHash: string) => Promise<void>;
  onSuccess?: (txHash: string) => void;
  onFailure?: (reason: TransactionFailureReason, detail: string) => void;
  network?: "testnet" | "mainnet";
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXPLORER_BASE: Record<string, string> = {
  testnet: "https://stellar.expert/explorer/testnet/tx/",
  mainnet: "https://stellar.expert/explorer/mainnet/tx/",
};

/** Best-effort classification of a caught error into a typed failure reason. */
function classifyError(err: unknown): TransactionFailureReason {
  if (typeof err === "object" && err !== null) {
    const code = (err as Record<string, unknown>).code;
    if (
      code === "USER_REJECTED" ||
      code === "userRejected" ||
      // Freighter / Lobstr rejection strings
      (typeof (err as { message?: unknown }).message === "string" &&
        /reject|cancel|deni/i.test((err as { message: string }).message))
    ) {
      return "user_rejected";
    }
    if (code === "SimulationFailed" || code === "simulation_failed") {
      return "simulation_failed";
    }
    if (code === "SubmissionFailed" || code === "submission_failed") {
      return "submission_failed";
    }
    if (code === "Timeout" || code === "timeout") {
      return "timeout";
    }
  }
  return "unknown";
}

const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTransactionFlow(
  options: UseTransactionFlowOptions
): UseTransactionFlowResult {
  const {
    builder,
    sign,
    submit,
    confirm,
    onSuccess,
    onFailure,
    network = "testnet",
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const [state, setState] = useState<TransactionFlowState>({
    stage: "idle",
    txHash: null,
    failureReason: null,
    errorDetail: null,
    explorerUrl: null,
  });

  // Guard so a re-mount / strict-mode double-invoke can't double-run.
  const inFlightRef = useRef(false);

  const reset = useCallback(() => {
    inFlightRef.current = false;
    setState({
      stage: "idle",
      txHash: null,
      failureReason: null,
      errorDetail: null,
      explorerUrl: null,
    });
  }, []);

  const run = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    const fail = (reason: TransactionFailureReason, detail: string) => {
      setState((prev) => ({
        ...prev,
        stage: "failed",
        failureReason: reason,
        errorDetail: detail,
      }));
      onFailure?.(reason, detail);
      inFlightRef.current = false;
    };

    // ── 1. Prepare (simulate / build XDR) ──────────────────────────────────
    setState({
      stage: "preparing",
      txHash: null,
      failureReason: null,
      errorDetail: null,
      explorerUrl: null,
    });

    let unsignedXdr: string;
    try {
      unsignedXdr = await builder();
    } catch (err) {
      const reason = classifyError(err);
      const detail =
        reason === "simulation_failed"
          ? parseStellarError(err)
          : parseStellarError(err);
      fail(reason === "unknown" ? "simulation_failed" : reason, detail);
      return;
    }

    // ── 2. Awaiting signature ───────────────────────────────────────────────
    setState((prev) => ({ ...prev, stage: "awaiting_signature" }));

    let signedXdr: string;
    try {
      signedXdr = await sign(unsignedXdr);
    } catch (err) {
      fail(classifyError(err) === "user_rejected" ? "user_rejected" : "user_rejected", parseStellarError(err));
      return;
    }

    // ── 3. Submit ───────────────────────────────────────────────────────────
    setState((prev) => ({ ...prev, stage: "submitted" }));

    let txHash: string;
    try {
      txHash = await submit(signedXdr);
    } catch (err) {
      fail("submission_failed", parseStellarError(err));
      return;
    }

    const explorerUrl = `${EXPLORER_BASE[network]}${txHash}`;
    setState((prev) => ({ ...prev, txHash, explorerUrl }));

    // ── 4. Confirm (optional polling with timeout) ──────────────────────────
    if (confirm) {
      try {
        await Promise.race([
          confirm(txHash),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject({ code: "Timeout" }), timeoutMs)
          ),
        ]);
      } catch (err) {
        const reason = classifyError(err);
        fail(reason === "timeout" ? "timeout" : "submission_failed", parseStellarError(err));
        return;
      }
    }

    // ── 5. Confirmed ────────────────────────────────────────────────────────
    setState((prev) => ({ ...prev, stage: "confirmed" }));
    onSuccess?.(txHash);
    inFlightRef.current = false;
  }, [builder, sign, submit, confirm, onSuccess, onFailure, network, timeoutMs]);

  return { ...state, run, reset };
}
