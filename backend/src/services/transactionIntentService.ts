import { z } from "zod";

import { getIntentConfig, type IntentConfig } from "../config/intentConfig";
import type { TransactionIntentRepository } from "../repositories/transactionIntentRepository";
import {
  intentCreatedTotal,
  intentLatencySeconds,
  intentOutcomeTotal,
  intentResumedTotal,
  intentSignRetryTotal,
} from "../utils/metrics";
import type {
  CreateIntentRequest,
  CreateIntentResult,
  IntentKind,
  TransactionIntentRecord,
} from "../types/transactionIntent";

const PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;
const IDEMPOTENCY_REGEX = /^[a-zA-Z0-9:_-]{8,128}$/;
const INTENT_KINDS = [
  "create_pool",
  "stake",
  "unstake",
  "join_arena",
  "commit_choice",
  "reveal_choice",
  "claim",
] as const satisfies readonly IntentKind[];

const CreateIntentRequestSchema = z.object({
  idempotencyKey: z.string().trim().regex(IDEMPOTENCY_REGEX, "Invalid idempotency key format"),
  kind: z.enum(INTENT_KINDS),
  unsignedXdr: z.string().trim().min(20, "unsignedXdr is too short").max(200_000, "unsignedXdr is too large"),
});

const SignedXdrSchema = z.string().trim().min(20, "signedXdr is too short").max(200_000, "signedXdr is too large");

function generateRecordId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `intent_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

const TERMINAL_STATUSES: ReadonlySet<TransactionIntentRecord["status"]> = new Set([
  "confirmed",
  "failed",
  "expired",
]);

/**
 * Raised when the caller tries to transition an intent from a status that
 * does not permit it (e.g. attaching a signature to an already-confirmed
 * intent). Kept distinct from a generic Error so controllers can map it to
 * a 409 rather than a 500.
 */
export class IntentStateError extends Error {
  readonly status = 409;
  readonly code = "INTENT_INVALID_STATE";

  constructor(intentId: string, from: TransactionIntentRecord["status"], action: string) {
    super(`Intent ${intentId} cannot ${action} from status "${from}"`);
    this.name = "IntentStateError";
  }
}

export class IntentNotFoundError extends Error {
  readonly status = 404;
  readonly code = "INTENT_NOT_FOUND";

  constructor(intentId: string) {
    super(`Intent ${intentId} not found`);
    this.name = "IntentNotFoundError";
  }
}

export class TransactionIntentService {
  private readonly config: IntentConfig;

  constructor(
    private readonly intents: TransactionIntentRepository,
    config?: IntentConfig
  ) {
    this.config = config ?? getIntentConfig();
  }

  /**
   * Create a new intent, or resume an existing unexpired one that matches
   * the same idempotency key. This is the entry point that makes retry
   * safe: a caller who lost track of whether their first request landed
   * (network blip, page refresh) gets the same record back instead of a
   * second, untracked one (#1381).
   */
  async createOrResumeIntent(
    input: unknown,
    ownerWallet: string
  ): Promise<CreateIntentResult> {
    const request = CreateIntentRequestSchema.parse(input) as CreateIntentRequest;
    if (!PUBLIC_KEY_REGEX.test(ownerWallet)) {
      throw new Error("Invalid owner wallet address");
    }

    const existing = await this.intents.findByIdempotencyKey(request.idempotencyKey);
    if (existing) {
      const resumed = await this.expireIfStale(existing);
      if (resumed.status !== "expired") {
        intentResumedTotal.inc({ kind: resumed.kind });
        return { mode: "resumed", intent: resumed };
      }
      // Fall through: the matched record is expired, so the caller needs a
      // fresh one. Idempotency keys are meant to be stable per logical
      // action, so the caller is expected to mint a new key for a rebuilt
      // envelope rather than reusing an expired one — surface that plainly
      // rather than silently minting a second record under the same key
      // (which would collide on the unique index).
      throw new Error(
        `Intent for idempotency key ${request.idempotencyKey} has expired; rebuild with a new idempotency key`
      );
    }

    const now = new Date();
    const intent: TransactionIntentRecord = {
      id: generateRecordId(),
      idempotencyKey: request.idempotencyKey,
      kind: request.kind,
      ownerWallet,
      status: "built",
      unsignedXdr: request.unsignedXdr,
      signedXdr: null,
      txHash: null,
      errorMessage: null,
      attempts: 0,
      signAttempts: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + this.config.ttlMs),
      confirmedAt: null,
    };

    await this.intents.insert(intent);
    intentCreatedTotal.inc({ kind: intent.kind });
    return { mode: "created", intent };
  }

  async getIntent(intentId: string, ownerWallet: string): Promise<TransactionIntentRecord> {
    const intent = await this.requireOwnedIntent(intentId, ownerWallet);
    return this.expireIfStale(intent);
  }

  /**
   * Mark an intent as handed to the wallet for signing. Bumps
   * `signAttempts` so repeated "try again" clicks after a rejection are
   * observable, and fails closed once `maxSignAttempts` is exhausted
   * rather than looping forever against a wallet that keeps rejecting.
   */
  async markAwaitingSignature(intentId: string, ownerWallet: string): Promise<TransactionIntentRecord> {
    const intent = await this.requireOwnedIntent(intentId, ownerWallet);
    const current = await this.expireIfStale(intent);
    if (current.status === "expired") return current;

    if (current.status !== "built" && current.status !== "awaiting_signature") {
      throw new IntentStateError(intentId, current.status, "move to awaiting_signature");
    }

    if (current.signAttempts >= this.config.maxSignAttempts) {
      const failed = await this.intents.update(intentId, {
        status: "failed",
        errorMessage: `Max sign attempts reached (${this.config.maxSignAttempts})`,
        updatedAt: new Date(),
      });
      this.recordTerminal(failed);
      return failed;
    }

    if (current.status === "awaiting_signature") {
      intentSignRetryTotal.inc({ kind: current.kind, reason: "retry" });
    }

    return this.intents.update(intentId, {
      status: "awaiting_signature",
      signAttempts: current.signAttempts + 1,
      errorMessage: null,
      updatedAt: new Date(),
    });
  }

  /**
   * Record that the wallet rejected the signature request, or the signing
   * UI timed out waiting for the wallet. Leaves the intent resumable
   * (status returns to "built") rather than terminal, so a client-side
   * "Try Again" can call markAwaitingSignature again against the *same*
   * record and unsigned XDR instead of building a fresh one (#1381's core
   * acceptance criterion: rebuild without submitting the original envelope
   * twice — there is nothing to resubmit until a signature actually
   * exists).
   */
  async recordSignatureRejectedOrExpired(
    intentId: string,
    ownerWallet: string,
    reason: "rejected" | "expired"
  ): Promise<TransactionIntentRecord> {
    const intent = await this.requireOwnedIntent(intentId, ownerWallet);
    const current = await this.expireIfStale(intent);
    if (current.status === "expired") return current;

    if (current.status !== "awaiting_signature") {
      throw new IntentStateError(intentId, current.status, "record a signature failure");
    }

    intentSignRetryTotal.inc({ kind: current.kind, reason });
    return this.intents.update(intentId, {
      status: "built",
      errorMessage: reason === "rejected" ? "Signature rejected by wallet" : "Signing window expired",
      updatedAt: new Date(),
    });
  }

  /**
   * Attach the wallet-produced signed XDR once signing succeeds, ahead of
   * submission (which the client still drives directly against Soroban
   * RPC via the existing submitSignedTransaction — this service only
   * tracks state, it never holds a key or submits on the user's behalf).
   */
  async attachSignedXdr(
    intentId: string,
    ownerWallet: string,
    signedXdr: string
  ): Promise<TransactionIntentRecord> {
    const validatedXdr = SignedXdrSchema.parse(signedXdr);
    const intent = await this.requireOwnedIntent(intentId, ownerWallet);
    const current = await this.expireIfStale(intent);
    if (current.status === "expired") return current;

    if (current.status !== "awaiting_signature") {
      throw new IntentStateError(intentId, current.status, "attach a signature");
    }

    return this.intents.update(intentId, {
      status: "submitted",
      signedXdr: validatedXdr,
      attempts: current.attempts + 1,
      errorMessage: null,
      updatedAt: new Date(),
    });
  }

  /**
   * Record the terminal outcome once the client's own call to
   * submitSignedTransaction resolves (confirmed) or throws (failed). The
   * client remains the source of truth for on-chain confirmation — this
   * call is bookkeeping, not a second submission path.
   */
  async recordSubmissionOutcome(
    intentId: string,
    ownerWallet: string,
    outcome: { status: "confirmed"; txHash: string } | { status: "failed"; errorMessage: string }
  ): Promise<TransactionIntentRecord> {
    const intent = await this.requireOwnedIntent(intentId, ownerWallet);
    const current = await this.expireIfStale(intent);
    if (current.status === "expired") return current;

    if (current.status !== "submitted") {
      throw new IntentStateError(intentId, current.status, "record a submission outcome");
    }

    const patch =
      outcome.status === "confirmed"
        ? {
            status: "confirmed" as const,
            txHash: outcome.txHash,
            confirmedAt: new Date(),
            errorMessage: null,
            updatedAt: new Date(),
          }
        : {
            status: "failed" as const,
            errorMessage: outcome.errorMessage,
            updatedAt: new Date(),
          };

    const updated = await this.intents.update(intentId, patch);
    this.recordTerminal(updated);
    return updated;
  }

  /**
   * Sweep intents whose TTL has lapsed while they were left untouched
   * (browser tab closed mid-flow, process restarted before a follow-up
   * call arrived). Safe to call repeatedly / concurrently — updates are
   * idempotent no-ops once an intent is already terminal (#1381's
   * "restart during work" edge case).
   */
  async expireStaleIntents(limit = 100): Promise<number> {
    const candidates = await this.intents.listByStatus(["built", "awaiting_signature", "submitted"], limit);
    let expiredCount = 0;
    for (const candidate of candidates) {
      const result = await this.expireIfStale(candidate);
      if (result.status === "expired") expiredCount += 1;
    }
    return expiredCount;
  }

  private async requireOwnedIntent(intentId: string, ownerWallet: string): Promise<TransactionIntentRecord> {
    const intent = await this.intents.findById(intentId);
    // Ownership and existence are indistinguishable to the caller (fail
    // closed, matching canAccessTransaction's pattern) so intent ids
    // cannot be probed to discover other users' activity.
    if (!intent || intent.ownerWallet !== ownerWallet) {
      throw new IntentNotFoundError(intentId);
    }
    return intent;
  }

  private async expireIfStale(intent: TransactionIntentRecord): Promise<TransactionIntentRecord> {
    if (TERMINAL_STATUSES.has(intent.status)) return intent;
    if (intent.expiresAt.getTime() > Date.now()) return intent;

    const expired = await this.intents.update(intent.id, {
      status: "expired",
      errorMessage: "Intent expired before reaching a terminal status",
      updatedAt: new Date(),
    });
    this.recordTerminal(expired);
    return expired;
  }

  private recordTerminal(intent: TransactionIntentRecord): void {
    intentOutcomeTotal.inc({ kind: intent.kind, status: intent.status });
    const latencySeconds = (intent.updatedAt.getTime() - intent.createdAt.getTime()) / 1000;
    intentLatencySeconds.observe({ kind: intent.kind, status: intent.status }, Math.max(latencySeconds, 0));
  }
}
