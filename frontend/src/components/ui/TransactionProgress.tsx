"use client";

/**
 * TransactionProgress — issue #1606
 *
 * Generic UI panel that renders the current stage of a useTransactionFlow
 * execution.  Feature modals embed this instead of duplicating their own
 * prepare/sign/submit/confirm UI.
 */

import React from "react";
import { Loader2, CheckCircle2, XCircle, ExternalLink, AlertTriangle, Clock } from "lucide-react";
import type {
  TransactionFlowStage,
  TransactionFailureReason,
} from "@/shared-d/hooks/useTransactionFlow";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TransactionProgressProps {
  stage: TransactionFlowStage;
  txHash: string | null;
  failureReason: TransactionFailureReason | null;
  errorDetail: string | null;
  explorerUrl: string | null;
  /** Override the label shown during the `confirmed` stage. */
  successLabel?: string;
  /** Callback from the parent when user wants to retry (resets to idle). */
  onRetry?: () => void;
  /** Callback from the parent when user dismisses (on success or permanent failure). */
  onDismiss?: () => void;
}

// ---------------------------------------------------------------------------
// Stage copy
// ---------------------------------------------------------------------------

const STAGE_COPY: Record<
  TransactionFlowStage,
  { heading: string; subtext: string }
> = {
  idle: { heading: "", subtext: "" },
  preparing: {
    heading: "Preparing transaction",
    subtext: "Simulating on Soroban…",
  },
  awaiting_signature: {
    heading: "Awaiting your signature",
    subtext: "Approve the transaction in your wallet.",
  },
  submitted: {
    heading: "Submitted to the network",
    subtext: "Waiting for on-chain confirmation…",
  },
  confirmed: {
    heading: "Transaction confirmed",
    subtext: "Your transaction has been included in the ledger.",
  },
  failed: {
    heading: "Transaction failed",
    subtext: "See details below.",
  },
};

const FAILURE_COPY: Record<TransactionFailureReason, string> = {
  user_rejected: "You rejected the transaction in your wallet.",
  simulation_failed:
    "The contract simulation returned an error. Check the details and try again.",
  submission_failed:
    "The transaction was rejected by the network. It may have already expired.",
  timeout:
    "Confirmation is taking longer than expected. Check the explorer for the final status.",
  unknown: "An unexpected error occurred.",
};

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-6" aria-live="polite" aria-label={label}>
      <Loader2 className="w-10 h-10 animate-spin text-lime-400" />
      <p className="text-sm font-bold tracking-widest uppercase text-gray-400">{label}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TransactionProgress({
  stage,
  txHash,
  failureReason,
  errorDetail,
  explorerUrl,
  successLabel,
  onRetry,
  onDismiss,
}: TransactionProgressProps) {
  if (stage === "idle") return null;

  const copy = STAGE_COPY[stage];
  const isInProgress =
    stage === "preparing" ||
    stage === "awaiting_signature" ||
    stage === "submitted";
  const isConfirmed = stage === "confirmed";
  const isFailed = stage === "failed";

  return (
    <div className="border-t-4 border-black" aria-live="polite" role="status">
      {/* ── In-progress states ──────────────────────────────────────────── */}
      {isInProgress && (
        <div className="px-6 py-8">
          <Spinner label={copy.heading} />
          <p className="text-center text-xs text-gray-400 mt-2">{copy.subtext}</p>
          {/* Show explorer link as soon as hash is known (post-submit) */}
          {explorerUrl && (
            <div className="mt-4 flex justify-center">
              <ExplorerLink href={explorerUrl} />
            </div>
          )}
        </div>
      )}

      {/* ── Confirmed ────────────────────────────────────────────────────── */}
      {isConfirmed && (
        <div className="px-6 py-8 flex flex-col items-center gap-4">
          <CheckCircle2 className="w-12 h-12 text-lime-400" aria-hidden="true" />
          <p className="text-xl font-black italic tracking-tight text-center">
            {successLabel ?? copy.heading}
          </p>
          <p className="text-sm text-gray-400 text-center">{copy.subtext}</p>
          {explorerUrl && <ExplorerLink href={explorerUrl} />}
          {onDismiss && (
            <button
              onClick={onDismiss}
              className="mt-2 w-full border-4 border-black bg-lime-400 py-3 px-6 font-black text-sm uppercase tracking-widest hover:bg-lime-300 active:scale-95 transition-all"
            >
              Done
            </button>
          )}
        </div>
      )}

      {/* ── Failed ───────────────────────────────────────────────────────── */}
      {isFailed && (
        <div className="px-6 py-8 flex flex-col items-center gap-4">
          {failureReason === "timeout" ? (
            <Clock className="w-12 h-12 text-yellow-400" aria-hidden="true" />
          ) : (
            <XCircle className="w-12 h-12 text-red-500" aria-hidden="true" />
          )}

          <p className="text-xl font-black italic tracking-tight text-center">
            {copy.heading}
          </p>

          <p className="text-sm text-gray-400 text-center">
            {failureReason ? FAILURE_COPY[failureReason] : copy.subtext}
          </p>

          {errorDetail && failureReason !== "user_rejected" && (
            <div className="w-full bg-black/80 border border-red-500/30 px-4 py-3">
              <p className="text-xs font-mono text-red-300 break-all">{errorDetail}</p>
            </div>
          )}

          {failureReason === "timeout" && explorerUrl && (
            <div className="flex items-center gap-2 text-yellow-300">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span className="text-xs">Check the explorer to see if it landed:</span>
            </div>
          )}

          {explorerUrl && <ExplorerLink href={explorerUrl} />}

          <div className="w-full flex flex-col gap-2 mt-2">
            {onRetry &&
              failureReason !== "user_rejected" &&
              failureReason !== "timeout" && (
                <button
                  onClick={onRetry}
                  className="w-full border-4 border-black bg-white py-3 px-6 font-black text-sm uppercase tracking-widest hover:bg-gray-100 active:scale-95 transition-all"
                >
                  Try again
                </button>
              )}
            {onDismiss && (
              <button
                onClick={onDismiss}
                className="w-full border-4 border-black bg-black text-white py-3 px-6 font-black text-sm uppercase tracking-widest hover:bg-gray-900 active:scale-95 transition-all"
              >
                Close
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Explorer link helper
// ---------------------------------------------------------------------------

function ExplorerLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs font-bold underline tracking-widest text-lime-400 hover:text-lime-300"
    >
      View on explorer <ExternalLink className="w-3 h-3" />
    </a>
  );
}
