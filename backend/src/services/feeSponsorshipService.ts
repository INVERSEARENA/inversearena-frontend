/**
 * Fee Sponsorship Service (#1413)
 *
 * Design note
 * -----------
 * Ownership   : Exclusively owns the lifecycle of a fee-sponsorship eligibility
 *               token for a winner's claim payout.
 *
 * State model : PENDING → CONSUMED (one-way, irreversible).
 *               EXPIRED is a virtual terminal state applied lazily when a
 *               token's TTL has elapsed without being consumed.
 *
 *   PENDING   — issued to a winner after their arena is SETTLED; the backend
 *               will cover the Stellar network fee for their claim.
 *   CONSUMED  — the token has been applied to exactly one payout submission.
 *               Re-use is rejected with 409 ELIGIBILITY_ALREADY_CONSUMED.
 *   EXPIRED   — the token was not consumed within TTL_HOURS.
 *
 * Atomicity   : `consumeEligibility` updates the record to CONSUMED in a
 *               single atomic write.  Concurrent requests with the same token
 *               will see a status that is no longer PENDING and receive a 409.
 *
 * Compatibility: Adds a new optional `sponsorFee` flag to POST /api/payouts.
 *               Existing payout creation calls that omit the flag are
 *               unaffected.  The config flag
 *               PAYOUTS_FEE_SPONSORSHIP_ENABLED (default false) gates the
 *               feature so it can be rolled out gradually.
 */

import { logger } from "../utils/logger";
import {
  feeEligibilityIssuedTotal,
  feeEligibilityConsumedTotal,
  feeEligibilityExpiredTotal,
} from "../utils/metrics";

// ── Config ────────────────────────────────────────────────────────────────────

export const FEE_SPONSORSHIP_ENABLED =
  process.env.PAYOUTS_FEE_SPONSORSHIP_ENABLED === "true";

/** Hours after which an unclaimed eligibility token expires. */
const TTL_HOURS = Number(process.env.PAYOUTS_FEE_SPONSORSHIP_TTL_HOURS ?? "72");

// ── Token types ───────────────────────────────────────────────────────────────

export type EligibilityStatus = "PENDING" | "CONSUMED" | "EXPIRED";

export interface FeeEligibilityToken {
  tokenId: string;
  payoutId: string;
  winnerId: string;
  issuedAt: string;  // ISO string
  expiresAt: string; // ISO string
  status: EligibilityStatus;
  consumedAt: string | null; // ISO string
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class EligibilityConsumedError extends Error {
  readonly status = 409;
  readonly code = "ELIGIBILITY_ALREADY_CONSUMED";

  constructor(readonly tokenId: string) {
    super(`Fee eligibility token ${tokenId} has already been consumed for a prior claim.`);
    this.name = "EligibilityConsumedError";
  }
}

export class EligibilityExpiredError extends Error {
  readonly status = 409;
  readonly code = "ELIGIBILITY_EXPIRED";

  constructor(readonly tokenId: string) {
    super(`Fee eligibility token ${tokenId} has expired. A new token must be issued.`);
    this.name = "EligibilityExpiredError";
  }
}

export class EligibilityNotFoundError extends Error {
  readonly status = 404;
  readonly code = "ELIGIBILITY_NOT_FOUND";

  constructor(readonly tokenId: string) {
    super(`Fee eligibility token ${tokenId} not found.`);
    this.name = "EligibilityNotFoundError";
  }
}

// ── In-process store (replace with Redis / DB in production) ──────────────────

// Keyed by tokenId.  In production this should be a Redis hash or Postgres
// table with a TTL index for automatic expiry.
const tokenStore = new Map<string, FeeEligibilityToken>();

// ── Service ───────────────────────────────────────────────────────────────────

export class FeeSponsorshipService {
  /**
   * Issue a new, one-time fee eligibility token for a winner.
   *
   * Idempotent per (payoutId, winnerId): issuing twice for the same pair
   * returns the existing token.
   */
  issueEligibility(payoutId: string, winnerId: string): FeeEligibilityToken {
    // Idempotency: return existing pending token for this payout.
    for (const token of tokenStore.values()) {
      if (token.payoutId === payoutId && token.winnerId === winnerId) {
        logger.debug({ payoutId, winnerId }, "fee_eligibility_idempotent_return");
        return token;
      }
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + TTL_HOURS * 60 * 60 * 1000);
    const tokenId = `fse_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const token: FeeEligibilityToken = {
      tokenId,
      payoutId,
      winnerId,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: "PENDING",
      consumedAt: null,
    };

    tokenStore.set(tokenId, token);
    feeEligibilityIssuedTotal.inc();
    logger.info({ tokenId, payoutId, winnerId }, "fee_eligibility_issued");

    return token;
  }

  /**
   * Atomically consume a fee eligibility token.
   * Throws if the token is not found, already consumed, or expired.
   * After this call the backend will sponsor the network fee for the payout.
   */
  consumeEligibility(tokenId: string): FeeEligibilityToken {
    const token = tokenStore.get(tokenId);
    if (!token) throw new EligibilityNotFoundError(tokenId);

    // Lazy expiry check
    if (token.status === "PENDING" && new Date() > new Date(token.expiresAt)) {
      const expired: FeeEligibilityToken = { ...token, status: "EXPIRED" };
      tokenStore.set(tokenId, expired);
      feeEligibilityExpiredTotal.inc();
      throw new EligibilityExpiredError(tokenId);
    }

    if (token.status === "CONSUMED") throw new EligibilityConsumedError(tokenId);
    if (token.status === "EXPIRED") throw new EligibilityExpiredError(tokenId);

    // Mark consumed — atomic in a single-process model.
    // In a clustered deployment, replace this with a Redis SET NX or a
    // Postgres UPDATE … WHERE status = 'PENDING' RETURNING *.
    const consumed: FeeEligibilityToken = {
      ...token,
      status: "CONSUMED",
      consumedAt: new Date().toISOString(),
    };
    tokenStore.set(tokenId, consumed);

    feeEligibilityConsumedTotal.inc();
    logger.info({ tokenId, payoutId: token.payoutId, winnerId: token.winnerId }, "fee_eligibility_consumed");

    return consumed;
  }

  /**
   * Retrieve a token by id (read-only).
   */
  getEligibility(tokenId: string): FeeEligibilityToken | null {
    return tokenStore.get(tokenId) ?? null;
  }

  /**
   * Returns all pending tokens for a given winner (for display in dashboard).
   */
  listPendingForWinner(winnerId: string): FeeEligibilityToken[] {
    const now = new Date();
    return Array.from(tokenStore.values()).filter(
      (t) =>
        t.winnerId === winnerId &&
        t.status === "PENDING" &&
        new Date(t.expiresAt) > now,
    );
  }

  /** Test helper — resets the in-process store. */
  _resetForTest(): void {
    tokenStore.clear();
  }
}

// Singleton instance.
export const feeSponsorshipService = new FeeSponsorshipService();
