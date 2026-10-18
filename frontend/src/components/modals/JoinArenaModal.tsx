"use client";

/**
 * JoinArenaModal — migrated to useTransactionFlow (#1606).
 *
 * This modal now only owns:
 *   • The pre-flight eligibility check.
 *   • The "I understand that minority wins" agreement checkbox.
 *   • A `builder` that calls `onConfirm` to obtain the signed XDR.
 *
 * The full build → sign → submit → confirm lifecycle, typed failure reasons,
 * retry semantics, and explorer links are delegated to useTransactionFlow +
 * TransactionProgress.
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { Modal } from "../ui/Modal";
import { TransactionProgress } from "../ui/TransactionProgress";
import { useTransactionFlow } from "@/shared-d/hooks/useTransactionFlow";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EligibilityError {
  code: string;
  message: string;
  severity: "error" | "warning";
}

interface JoinArenaModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * The caller builds the transaction, signs it with the wallet, submits it,
   * and returns the transaction hash. Throwing with `{ code: "USER_REJECTED" }`
   * surfaces as a user-rejected failure in the flow.
   *
   * Migrated: previously `onConfirm` returned `Promise<void>`; it now returns
   * `Promise<string>` (the tx hash) so TransactionProgress can display an
   * explorer link.
   */
  onConfirm: () => Promise<string>;
  arenaId: number;
  requiredStake: number;
  currentPlayers: number;
  maxPlayers: number;
  yieldGeneration: number;
  arenaStatus: "ACTIVE" | "INACTIVE";
  walletBalance?: number;
  balanceAsset?: "USDC" | "XLM" | "EURC";
  invitationCode?: string;
  network?: "testnet" | "mainnet";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const JoinArenaModal: React.FC<JoinArenaModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  arenaId,
  requiredStake,
  currentPlayers,
  maxPlayers,
  yieldGeneration,
  arenaStatus,
  walletBalance = 0,
  balanceAsset = "USDC",
  invitationCode,
  network = "testnet",
}) => {
  const [isChecked, setIsChecked] = useState(false);
  const [eligibilityErrors, setEligibilityErrors] = useState<EligibilityError[]>([]);
  const [eligibilityWarnings, setEligibilityWarnings] = useState<string[]>([]);
  const isMountedRef = useRef(true);

  // ── Transaction flow ───────────────────────────────────────────────────────
  //
  // builder: wraps `onConfirm` — the caller is responsible for build+sign+submit
  //          and returns the tx hash. We pass it through so the flow stages still
  //          work (prepare = eligibility, awaiting_signature → confirmed).
  //          For a fuller decomposition each modal would pass separate sign/submit
  //          functions; here we keep the existing API boundary and treat the
  //          whole call as the "builder+sign+submit" bundle.

  const builder = useCallback(async () => {
    // No-op XDR; the real work happens in `submit` below to preserve the
    // existing onConfirm API (which handles build+sign+submit internally).
    return "noop_xdr";
  }, []);

  const sign = useCallback(async (xdr: string) => xdr, []);

  const submit = useCallback(async (_signedXdr: string) => {
    return await onConfirm();
  }, [onConfirm]);

  const flow = useTransactionFlow({
    builder,
    sign,
    submit,
    network,
  });

  // ── Reset when modal opens / closes ───────────────────────────────────────

  useEffect(() => {
    isMountedRef.current = true;
    if (isOpen) {
      setIsChecked(false);
      flow.reset();
      checkEligibility();
    }
    return () => {
      isMountedRef.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, walletBalance, balanceAsset, invitationCode]);

  const checkEligibility = async () => {
    try {
      const response = await fetch(`/api/arenas/${arenaId}/eligibility-preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ balance: walletBalance, balanceAsset }),
      });
      if (!response.ok) {
        const data = await response.json();
        if (isMountedRef.current) {
          setEligibilityErrors(data.errors || []);
          setEligibilityWarnings(data.warnings || []);
        }
      } else {
        if (isMountedRef.current) {
          setEligibilityErrors([]);
          const data = await response.json();
          setEligibilityWarnings(data.warnings || []);
        }
      }
    } catch {
      // Non-fatal — let the user proceed if the eligibility endpoint is down.
    }
  };

  /**
   * The one definition of "this join may proceed".
   */
  const canConfirm =
    isChecked &&
    eligibilityErrors.length === 0 &&
    flow.stage === "idle";

  const isInFlow =
    flow.stage !== "idle" &&
    flow.stage !== "confirmed" &&
    flow.stage !== "failed";

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <div className="bg-white border-4 border-black text-black">
        {/* ── Header ───────────────────────────────────────────────────── */}
        <div className="border-b-4 border-black px-6 md:px-8 py-6">
          <h1 className="text-3xl md:text-4xl font-black italic text-left tracking-tight">
            JOIN ARENA #{arenaId}
          </h1>
        </div>

        {/* ── Stats Grid ────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 border-b-4 border-black">
          <div className="border-b-4 md:border-b-0 md:border-r-4 border-black px-6 md:px-8 py-6">
            <p className="text-xs font-bold tracking-widest text-left text-gray-600 mb-2">
              REQUIRED STAKE
            </p>
            <p className="text-2xl md:text-3xl text-left font-black">
              {requiredStake} USDC
            </p>
          </div>

          <div className="px-6 md:px-8 py-6">
            <p className="text-xs text-left font-bold tracking-widest text-gray-600 mb-2">
              CURRENT PLAYERS
            </p>
            <p className="text-2xl md:text-3xl text-left font-black text-lime-400">
              {currentPlayers} / {maxPlayers}
            </p>
          </div>
        </div>

        {/* ── Yield Section ─────────────────────────────────────────────── */}
        <div className="border-b-4 border-black px-6 md:px-8 py-6 flex items-center justify-between">
          <div>
            <p className="text-xs font-bold text-left tracking-widest text-gray-600 mb-2">
              YIELD GENERATION
            </p>
            <p className="text-2xl md:text-3xl font-black">{yieldGeneration}% APY</p>
          </div>
          <div
            className={`bg-black px-3 py-2 ${
              arenaStatus === "ACTIVE" ? "text-lime-400" : "text-red-500"
            }`}
          >
            <span className="text-xs font-black tracking-widest">
              ■ {arenaStatus}
            </span>
          </div>
        </div>

        {/* ── Eligibility Errors ────────────────────────────────────────── */}
        {eligibilityErrors.length > 0 && (
          <div className="border-b-4 border-red-500 px-6 md:px-8 py-4 bg-red-50">
            <p className="text-xs font-bold tracking-widest text-red-700 mb-2">
              ELIGIBILITY ISSUES
            </p>
            {eligibilityErrors.map((error, idx) => (
              <p key={idx} className="text-sm text-red-600 mb-1">
                • {error.message}
              </p>
            ))}
          </div>
        )}

        {/* ── Eligibility Warnings ─────────────────────────────────────── */}
        {eligibilityWarnings.length > 0 && (
          <div className="border-b-4 border-yellow-500 px-6 md:px-8 py-4 bg-yellow-50">
            <p className="text-xs font-bold tracking-widest text-yellow-700 mb-2">
              WARNINGS
            </p>
            {eligibilityWarnings.map((warning, idx) => (
              <p key={idx} className="text-sm text-yellow-600 mb-1">
                ⚠ {warning}
              </p>
            ))}
          </div>
        )}

        {/* ── Agreement Checkbox (hidden while flow is running) ─────────── */}
        {!isInFlow && flow.stage !== "confirmed" && (
          <div className="px-6 md:px-8 py-6">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isChecked}
                onChange={(e) => setIsChecked(e.target.checked)}
                disabled={eligibilityErrors.length > 0}
                className="mt-1 w-6 h-6 border-2 border-black cursor-pointer accent-black disabled:opacity-50"
              />
              <span className="text-md md:text-lg italic font-bold leading-tight">
                I UNDERSTAND THAT MINORITY WINS.
              </span>
            </label>
          </div>
        )}

        {/* ── Transaction progress (appears once flow starts) ───────────── */}
        <TransactionProgress
          stage={flow.stage}
          txHash={flow.txHash}
          failureReason={flow.failureReason}
          errorDetail={flow.errorDetail}
          explorerUrl={flow.explorerUrl}
          successLabel="You have joined the arena!"
          onRetry={flow.reset}
          onDismiss={onClose}
        />

        {/* ── Action buttons (only shown before the flow starts) ───────── */}
        {flow.stage === "idle" && (
          <div className="space-y-4 p-6">
            <button
              onClick={flow.run}
              disabled={!canConfirm}
              className={`w-full border-3 border-black py-4 px-6 font-black text-lg italic tracking-wide transition-all ${
                canConfirm
                  ? "bg-lime-400 text-black hover:bg-lime-300 active:scale-95"
                  : "bg-gray-200 text-gray-400 cursor-not-allowed"
              }`}
            >
              {eligibilityErrors.length > 0 ? "INELIGIBLE" : "CONFIRM ENTRY"}
            </button>

            <button
              onClick={onClose}
              className="w-full border-3 border-black bg-white py-4 px-6 font-black text-lg tracking-wide hover:bg-gray-50 active:scale-95 transition-all"
            >
              CANCEL
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
};

export default JoinArenaModal;
