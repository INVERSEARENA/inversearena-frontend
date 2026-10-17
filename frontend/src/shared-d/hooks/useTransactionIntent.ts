/**
 * Tracks a user-wallet-signed action (create pool, stake, unstake, join
 * arena, commit/reveal a choice, claim winnings) against the backend's
 * `/api/transaction-intents` resource, so a wallet rejection or an expired
 * signing window can be resumed against the same record instead of
 * silently rebuilding a fresh, untracked transaction every retry (#1381).
 * See docs/TRANSACTION_INTENTS.md for the full design.
 *
 * Deliberately non-fatal to the underlying wallet flow: if the intents API
 * is unreachable, the hook logs and proceeds without a tracked intent
 * rather than blocking the user from signing (see docs/TRANSACTION_INTENTS.md
 * §4 — resumability is a reliability improvement, not a new hard
 * dependency for the golden path).
 */
import { useCallback } from "react";
import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
const SESSION_STORAGE_PREFIX = "inversearena:intent-key";

export type IntentKind =
  | "create_pool"
  | "stake"
  | "unstake"
  | "join_arena"
  | "commit_choice"
  | "reveal_choice"
  | "claim";

interface TransactionIntent {
  id: string;
  status: "built" | "awaiting_signature" | "submitted" | "confirmed" | "failed" | "expired";
  unsignedXdr: string;
  signAttempts: number;
  attempts: number;
}

export interface RunTrackedTransactionOptions {
  /** Which action this is — used for the backend's metrics/observability breakdown. */
  kind: IntentKind;
  /**
   * A stable identifier for this specific logical action, e.g. `stake:${amount}` or
   * `join_arena:${arenaId}`. Combined with the wallet address to derive the
   * idempotency key persisted in sessionStorage, so a page refresh mid-flow
   * can still resume the same intent. Does NOT need to be globally unique on
   * its own — only unique per (wallet, logical action).
   */
  actionKey: string;
  /** The signing wallet's public key. */
  publicKey: string;
  /** Builds the unsigned transaction. Called once per attempt (not cached), matching existing call sites' behavior. */
  buildTransaction: () => Promise<Transaction>;
  /** Wallet signing call, e.g. useWallet().signTransaction. */
  signTransaction: (xdr: string) => Promise<string>;
  /**
   * Submits the signed XDR and resolves once confirmed, e.g. via the
   * existing submitSignedTransaction. Its resolved value is not inspected —
   * the transaction hash the backend records comes from decoding the signed
   * XDR directly (submitSignedTransaction's own return value doesn't carry
   * one; only its thrown ContractError does, via err.hash).
   */
  submitSignedTransaction: (signedXdr: string) => Promise<unknown>;
  /** Same network passphrase submitSignedTransaction was built against, needed to decode the signed XDR's hash. */
  networkPassphrase: string;
  /** Called once the wallet has returned a signature, before submission — same contract as TransactionModal's onSigned. */
  onSigned?: () => void;
}

function isWalletRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("User rejected") || message.includes("user cancel");
}

async function postJson<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Derives a stable idempotency key for one logical action by one wallet,
 * persisted in sessionStorage so a page refresh mid-flow resumes the same
 * backend intent record rather than losing track of it. sessionStorage
 * (not localStorage) deliberately scopes this to the current tab/session —
 * an abandoned intent from a previous session is expected to expire
 * server-side (see docs/TRANSACTION_INTENTS.md §5) rather than be resumed
 * indefinitely.
 */
function deriveIdempotencyKey(kind: IntentKind, actionKey: string, publicKey: string): string {
  const storageKey = `${SESSION_STORAGE_PREFIX}:${kind}:${actionKey}:${publicKey}`;
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing) return existing;

    const fresh = `${kind}:${publicKey.slice(0, 12)}:${crypto.randomUUID()}`;
    sessionStorage.setItem(storageKey, fresh);
    return fresh;
  } catch {
    // Private browsing / storage disabled — fall back to a key that is
    // stable for this call but won't survive a refresh. The underlying
    // wallet flow still works; only cross-refresh resumption is lost.
    return `${kind}:${publicKey.slice(0, 12)}:${crypto.randomUUID()}`;
  }
}

function clearIdempotencyKey(kind: IntentKind, actionKey: string, publicKey: string): void {
  try {
    sessionStorage.removeItem(`${SESSION_STORAGE_PREFIX}:${kind}:${actionKey}:${publicKey}`);
  } catch {
    // Nothing to clean up if storage was never reachable.
  }
}

export function useTransactionIntent() {
  const runTrackedTransaction = useCallback(
    async (options: RunTrackedTransactionOptions): Promise<{ hash: string }> => {
      const {
        kind,
        actionKey,
        publicKey,
        buildTransaction,
        signTransaction,
        submitSignedTransaction,
        networkPassphrase,
        onSigned,
      } = options;

      const tx = await buildTransaction();
      const unsignedXdr = tx.toXDR();

      const idempotencyKey = deriveIdempotencyKey(kind, actionKey, publicKey);
      const createResult = await postJson<{ intent: TransactionIntent }>("/api/transaction-intents", {
        ownerWallet: publicKey,
        idempotencyKey,
        kind,
        unsignedXdr,
      });
      const intentId = createResult?.intent?.id ?? null;

      if (intentId) {
        await postJson(`/api/transaction-intents/${intentId}/awaiting-signature`, { ownerWallet: publicKey });
      }

      let signedXdr: string;
      try {
        signedXdr = await signTransaction(unsignedXdr);
      } catch (error) {
        if (intentId) {
          await postJson(`/api/transaction-intents/${intentId}/signature-failure`, {
            ownerWallet: publicKey,
            reason: isWalletRejection(error) ? "rejected" : "expired",
          });
        }
        throw error;
      }

      onSigned?.();

      if (intentId) {
        await postJson(`/api/transaction-intents/${intentId}/signed`, { ownerWallet: publicKey, signedXdr });
      }

      try {
        await submitSignedTransaction(signedXdr);
        // Decoding the signed XDR to recover its hash is purely for the
        // backend's bookkeeping record — it must never gate the actual
        // submission result above. A hash-decode failure here still means
        // the transaction was genuinely submitted.
        let hash = "";
        try {
          hash = TransactionBuilder.fromXDR(signedXdr, networkPassphrase).hash().toString("hex");
        } catch {
          // Leave hash empty; the outcome call below still records
          // "confirmed" without a hash rather than losing the outcome.
        }
        if (intentId) {
          await postJson(`/api/transaction-intents/${intentId}/outcome`, {
            ownerWallet: publicKey,
            status: "confirmed",
            txHash: hash || "unknown",
          });
        }
        // The envelope reached a terminal, successful state — the
        // idempotency key must not be reused for a future action (a fresh
        // action needs its own fresh key), so it is safe and correct to
        // free it here.
        clearIdempotencyKey(kind, actionKey, publicKey);
        return { hash };
      } catch (error) {
        if (intentId) {
          const message = error instanceof Error ? error.message : "Submission failed";
          await postJson(`/api/transaction-intents/${intentId}/outcome`, {
            ownerWallet: publicKey,
            status: "failed",
            errorMessage: message,
          });
        }
        throw error;
      }
    },
    []
  );

  return { runTrackedTransaction };
}
