/**
 * Claim and refund inbox service (#1489).
 *
 * Aggregates three sources that previously had to be consulted separately and
 * could disagree with each other:
 *
 *   1. **Mongo payout records** — winnings that have been created, signed,
 *      submitted or confirmed.
 *   2. **PostgreSQL cancellation recovery** — stakes owed back because an
 *      arena was cancelled.
 *   3. **On-chain arena state** — whether the arena has actually finished,
 *      which is the precondition for any winnings being claimable at all.
 *
 * ## The failure this is built around
 *
 * Each source can fail independently, and the dangerous failure is silent. If
 * the RPC is down and the service reports "not claimable", the user is shown an
 * empty inbox and concludes there is nothing to collect — while their payout
 * sits unclaimed, and possibly past its window. So a failed chain read
 * produces `state: "unavailable"` with a retry action, and never `actionable`,
 * never `completed`, and never a zeroed amount. The same applies to a record
 * that is too old to trust: it is `stale`, and the client is told so rather
 * than being handed a confident answer.
 *
 * ## One item per arena
 *
 * A wallet that won a pot and is also owed a cancelled stake in the same arena
 * gets one item with two components. Two rows would show the same position
 * twice and invite a second signature.
 *
 * @module
 */

import type { PrismaClient } from "@prisma/client";
import type { TransactionRepository } from "../repositories/transactionRepository";
import type { ClaimInboxArenaState, ClaimInboxItem, ClaimInboxPage } from "../types/claimInbox";
import {
  claimInboxSourceCount,
  claimInboxScanDuration,
  claimInboxItemCount,
  claimInboxActionableItems,
} from "../utils/metrics";
import { aggregate, buildItem, summarize, encodeCursor, decodeCursor } from "./claimInboxPresenter";
import { loadRefundsSafely, verifyArenasSafely } from "./claimInboxSafety";
import { TransactionPayoutClaimSource } from "./claimInboxSources";

/**
 * A record older than this is reported with `stale: true`.
 *
 * Ten minutes is long enough that a busy reconciler does not make every item
 * look stale, and short enough that a genuinely abandoned payout is flagged
 * before the user assumes the figure is current.
 */
export const CLAIM_INBOX_STALE_AFTER_MS = 10 * 60 * 1000;

/** Maximum arenas verified on chain in one scan. */
export const CLAIM_INBOX_MAX_VERIFY = 25;

/** Wall-clock budget for the whole chain read, in milliseconds. */
export const CLAIM_INBOX_VERIFY_BUDGET_MS = 4_000;

/**
 * Refundable positions derived from cancellation recovery.
 *
 * Structurally compatible with `ParticipantRecovery`, but declared here so the
 * service does not depend on the cancellation service's full interface (and
 * so a test does not need a Prisma client to supply one).
 */
export interface ClaimInboxRefundCandidate {
  arenaId: string;
  arenaName: string | null;
  walletAddress: string;
  /**
   * Asset the refund is denominated in. Stated rather than derived, because a
   * position may hold a winnings asset and a refund asset at once and
   * totalling them under one code would be a lie.
   */
  assetCode: string;
  refundAmountStroops: string;
  recoveryStatus: "refundable" | "submitted" | "confirmed" | "failed";
  txHash?: string | null;
  confirmedAt?: string | null;
  updatedAt?: Date | null;
}

/** On-chain verification, injected so the service is testable without RPC. */
export type ClaimInboxVerifier = (
  arenaIds: readonly string[],
) => Promise<Map<string, ClaimInboxArenaState>>;

/** Source of refundable stakes. */
export type ClaimInboxRefundSource = (
  walletAddress: string,
) => Promise<ClaimInboxRefundCandidate[]>;

export interface ClaimInboxDeps {
  prisma: PrismaClient;
  transactions: TransactionRepository;
  verifyArenas?: ClaimInboxVerifier;
  findRefunds?: ClaimInboxRefundSource;
  now?: () => number;
  maxVerify?: number;
  /**
   * Explicit `CODE -> ISSUER` map. Injected rather than read from `process.env`
   * so the mapping is visible at the call site and testable.
   */
  assetIssuers?: Record<string, string>;
  verifyBudgetMs?: number;
}

/**
 * Sort key for a position with no record timestamp.
 *
 * Must be stable across requests. Falling back to "now" would give the same
 * position a different key on every read, so a keyset cursor taken from a
 * previous page could skip it or return it twice. Epoch sorts it last, which is
 * also the honest answer: we do not know when this happened.
 */
export class ClaimInboxService {
  private readonly payoutSource: TransactionPayoutSource;
  private readonly verifyArenas: ClaimInboxVerifier;
  private readonly findRefunds: ClaimInboxRefundSource;
  private readonly now: () => number;

  constructor(private readonly deps: ClaimInboxDeps) {
    this.payoutSource = new TransactionPayoutClaimSource(deps.transactions);
    this.now = deps.now ?? Date.now;
    this.verifyArenas = deps.verifyArenas ?? defaultNoVerify;
    this.findRefunds = deps.findRefunds ?? defaultNoRefunds;
  }

  /**
   * One page of the calling wallet's inbox.
   *
   * @param walletAddress the authenticated caller. Every source query is
   *   scoped by it, so a position belonging to another wallet cannot appear
   *   here regardless of what the client asks for.
   */
  async getInbox(
    walletAddress: string,
    limit: number,
    cursor?: string | null,
  ): Promise<ClaimInboxPage> {
    const startedAt = this.now();
    const decoded = cursor ? decodeCursor(cursor) : null;

    // ── Sources ────────────────────────────────────────────────────────────
    // Fetch one extra row to detect a further page without a count query.
    const scanLimit = Math.min(limit * 4 + 1, 200);
    const [payouts, refunds] = await Promise.all([
      this.payoutSource.list(
        walletAddress,
        scanLimit,
        decoded ? { updatedAt: new Date(decoded.sortKey), id: decoded.id } : null,
      ),
      // A refund source that throws must not take the whole inbox down: the
      // Mongo records still describe real money the user is owed.
      loadRefundsSafely(this.findRefunds, walletAddress),
    ]);

    claimInboxSourceCount.inc({ source: "payouts" }, payouts.length);
    claimInboxSourceCount.inc({ source: "cancellation_recovery" }, refunds.length);

    // ── Aggregate to one position per arena ───────────────────────────────
    const positions = aggregate(walletAddress, payouts, refunds);

    // ── Bounded on-chain verification ─────────────────────────────────────
    const candidates = positions.slice(0, this.deps.maxVerify ?? CLAIM_INBOX_MAX_VERIFY);
    const chainStates = await verifyArenasSafely(this.verifyArenas, candidates.map((p) => p.arenaId), this.deps.verifyBudgetMs ?? CLAIM_INBOX_VERIFY_BUDGET_MS);
    const verifiedAt = new Date(this.now()).toISOString();
    // Unverified for two distinct reasons, and the page must not imply
    // otherwise: reads that failed, and positions past the verification cap
    // that were never read at all.
    const overCap = positions.length - candidates.length;
    const verificationComplete = chainStates.failed === 0 && overCap === 0;

    const nowMs = this.now();
    const all: ClaimInboxItem[] = positions.map((position) =>
      buildItem({
        position,
        chainState: chainStates.states.get(position.arenaId) ?? null,
        verifiedAt,
        nowMs,
        staleAfterMs: CLAIM_INBOX_STALE_AFTER_MS,
        assetIssuers: this.deps.assetIssuers ?? {},
      }),
    );

    // ── Keyset page ───────────────────────────────────────────────────────
    // Already sorted newest-first by `sortKey`, and the cursor is a position
    // in that same order, so paging is a slice rather than a re-query.
    const page = all.slice(0, limit);
    const hasMore = all.length > limit;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor({ sortKey: last.sortKey, id: last.id }) : null;

    const scanLatencyMs = this.now() - startedAt;
    claimInboxScanDuration.observe({ result: "page" }, scanLatencyMs / 1000);
    for (const item of page) {
      claimInboxItemCount.inc({ state: item.state }, 1);
    }
    claimInboxActionableItems.set(summarize(all).actionable);

    return {
      version: 1,
      walletAddress,
      items: page,
      summary: summarize(all),
      cursor: nextCursor,
      hasMore,
      verificationComplete,
      scanLatencyMs,
      sources: { payouts: payouts.length, cancellationRecovery: refunds.length },
    };
  }

}

/* -------------------------------------------------------------------------- */
/* Default sources                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Default refund source: no positions.
 *
 * The real source reads cancellation recovery and is constructed by the route,
 * which already has a Prisma client. The service takes both sources by
 * injection so it can be exercised with no database and no network at all.
 */
const defaultNoRefunds: ClaimInboxRefundSource = async () => [];

/**
 * Used when the caller supplies no verifier: nothing is knowable on chain, so
 * every position reports `unavailable` rather than being guessed from records
 * alone. A wrong answer here would present real money as unclaimable.
 */
const defaultNoVerify: ClaimInboxVerifier = async () => new Map();

export { encodeCursor, decodeCursor };
