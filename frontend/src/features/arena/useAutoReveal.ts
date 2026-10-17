"use client";

import { useEffect, useRef, useState } from "react";
import {
  buildRevealChoiceTransaction,
  clearCommitmentForRound,
  submitSignedTransaction,
} from "@/shared-d/utils/stellar-transactions";

export type AutoRevealPhase = "waiting" | "ready" | "signing" | "submitted" | "confirmed" | "failed";

export interface AutoRevealState {
  phase: AutoRevealPhase;
  error: string | null;
}

interface UseAutoRevealOptions {
  arenaId: string;
  roundNumber: number;
  phase: "commit" | "reveal" | "resolved";
  revealDeadline: number | null;
  publicKey: string | null;
  signTransaction: (xdr: string) => Promise<string>;
  enabled?: boolean;
  buildTransaction?: typeof buildRevealChoiceTransaction;
  submitTransaction?: typeof submitSignedTransaction;
}

const LEASE_MS = 15_000;
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 15_000;

function lockKey(arenaId: string, roundNumber: number, publicKey: string): string {
  return `inversearena:auto-reveal:${arenaId}:${roundNumber}:${publicKey}`;
}

function isTerminalRevealError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ChoiceAlreadyRevealed|InvalidReveal|MissingCommitment|No commitment found|PlayerEliminated|user rejected|request rejected|denied|locked/i.test(message);
}

function isRetryableRevealError(error: unknown): boolean {
  if (isTerminalRevealError(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  // A wallet prompt is a user action, not an RPC operation. Reopening it on
  // a timer is surprising and can create repeated signing prompts.
  if (/wallet|signature|sign transaction/i.test(message)) return false;
  return /rpc|network|timeout|timed out|temporar|fetch|connection|rate.?limit|unavailable|not found/i.test(message);
}

function acquireLease(key: string): boolean {
  const now = Date.now();
  const raw = localStorage.getItem(key);
  if (raw) {
    try {
      const lease = JSON.parse(raw) as { expiresAt?: number };
      if (typeof lease.expiresAt === "number" && lease.expiresAt > now) return false;
    } catch {
      // Replace corrupt coordination state.
    }
  }
  localStorage.setItem(key, JSON.stringify({ expiresAt: now + LEASE_MS }));
  return true;
}

function notifyRevealWindow(): void {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  new Notification("Reveal window open", { body: "Your committed arena choice is ready to reveal." });
}

export function useAutoReveal({
  arenaId,
  roundNumber,
  phase,
  revealDeadline,
  publicKey,
  signTransaction,
  enabled = true,
  buildTransaction = buildRevealChoiceTransaction,
  submitTransaction = submitSignedTransaction,
}: UseAutoRevealOptions): AutoRevealState {
  const [state, setState] = useState<AutoRevealState>({ phase: "waiting", error: null });
  const runningRef = useRef(false);
  const buildTransactionRef = useRef(buildTransaction);
  const submitTransactionRef = useRef(submitTransaction);
  const signTransactionRef = useRef(signTransaction);

  useEffect(() => {
    buildTransactionRef.current = buildTransaction;
    submitTransactionRef.current = submitTransaction;
    signTransactionRef.current = signTransaction;
  }, [buildTransaction, signTransaction, submitTransaction]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = INITIAL_RETRY_MS;

    if (!enabled || !arenaId || !publicKey || phase !== "reveal" || revealDeadline === null) {
      return () => undefined;
    }

    const deadlineMs = revealDeadline > 10_000_000_000 ? revealDeadline : revealDeadline * 1000;
    if (Date.now() >= deadlineMs) {
      const expiredTimer = setTimeout(
        () => setState({ phase: "failed", error: "Reveal window closed before the reveal could be submitted." }),
        0,
      );
      return () => clearTimeout(expiredTimer);
    }

    notifyRevealWindow();
    const readyTimer = setTimeout(() => {
      if (!runningRef.current) setState({ phase: "ready", error: null });
    }, 0);
    const key = lockKey(arenaId, roundNumber, publicKey);
    if (runningRef.current || !acquireLease(key)) {
      return () => clearTimeout(readyTimer);
    }
    runningRef.current = true;

    const run = async (): Promise<void> => {
      if (cancelled || Date.now() >= deadlineMs) {
        if (!cancelled) setState({ phase: "failed", error: "Reveal window closed before the reveal could be submitted." });
        return;
      }
      try {
        setState({ phase: "signing", error: null });
        const transaction = await buildTransactionRef.current(publicKey, arenaId, roundNumber);
        const signedXdr = await signTransactionRef.current(transaction.toXDR());
        if (cancelled) return;
        setState({ phase: "submitted", error: null });
        await submitTransactionRef.current(signedXdr);
        if (cancelled) return;
        clearCommitmentForRound(arenaId, roundNumber, publicKey);
        setState({ phase: "confirmed", error: null });
      } catch (error) {
        if (cancelled) return;
        if (!isRetryableRevealError(error) || Date.now() + retryDelay >= deadlineMs) {
          setState({
            phase: "failed",
            error: error instanceof Error ? error.message : "Reveal failed",
          });
          return;
        }
        setState({ phase: "ready", error: error instanceof Error ? error.message : "Temporary reveal failure" });
        retryTimer = setTimeout(() => void run(), retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
      }
    };

    void run();
    return () => {
      cancelled = true;
      runningRef.current = false;
      clearTimeout(readyTimer);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [arenaId, enabled, phase, publicKey, revealDeadline, roundNumber]);

  if (!enabled || !arenaId || !publicKey || phase !== "reveal" || revealDeadline === null) {
    return { phase: "waiting", error: null };
  }
  return state;
}
