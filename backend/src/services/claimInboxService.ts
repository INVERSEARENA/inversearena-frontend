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
import type { PaymentStatus, TransactionRecord } from "../types/payment";
import type {
  ClaimInboxAsset,
  ClaimInboxComponent,
  ClaimInboxCursor,
  ClaimInboxItem,
  ClaimInboxPage,
  ClaimInboxPositionKind,
  ClaimInboxReason,
  ClaimInboxState,
  ClaimInboxSummary,
  ClaimInboxArenaState,
} from "../types/claimInbox";
import {
  claimInboxActionableItems,
  claimInboxScanDuration,
  claimInboxSourceCount,
  claimInboxVerificationFailures,
  claimInboxItemCount,
  claimInboxUnconfiguredAssets,
} from "../utils/metrics";
import { logger } from "../utils/logger";

/**
 * Statuses that mean a transaction is already moving and the chain decides.
 *
 * `built` is deliberately *not* here. A built payout has unsigned XDR and has
 * never been submitted, so the arena's winnings are still claimable and the
 * user still has something to do — which is the same rule the existing
 * per-arena `getClaimReadiness` applies, where only `submitted` and
 * `confirmed` block a claim.
 */
const LIVE_PAYOUT_STATUSES: PaymentStatus[] = [
  "queued",
  "awaiting_signature",
  "submitted",
];

/** Statuses that mean the payout will not move again without intervention. */
const TERMINAL_PAYOUT_STATUSES: PaymentStatus[] = ["confirmed", "failed", "dead"];

/**
 * Statuses counted as "settled".
 *
 * `unknown` is deliberately excluded: a payout the reconciler has given up on
 * understanding is not a completed claim, and presenting it as one would
 * remove it from the actionable list on the strength of a failure.
 */
const SETTLED_STATUSES: PaymentStatus[] = ["confirmed"];

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
const UNKNOWN_SORT_KEY = "1970-01-01T00:00:00.000Z";

/**
 * XLM is native and has no issuer. Every other code must be configured
 * explicitly — see `parseAssetIssuers`. A code that is neither native nor
 * configured is reported with a null issuer and counted, because inventing one
 * would tell a client to trust an account nobody chose.
 */
const NATIVE_ASSET_CODE = "XLM";

export class ClaimInboxService {
  private readonly verifyArenas: ClaimInboxVerifier;
  private readonly findRefunds: ClaimInboxRefundSource;
  private readonly now: () => number;

  constructor(private readonly deps: ClaimInboxDeps) {
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
      this.deps.transactions.listByDestination(
        walletAddress,
        scanLimit,
        decoded ? { updatedAt: new Date(decoded.sortKey), id: decoded.id } : null,
      ),
      // A refund source that throws must not take the whole inbox down: the
      // Mongo records still describe real money the user is owed.
      this.safeRefunds(walletAddress),
    ]);

    claimInboxSourceCount.inc({ source: "payouts" }, payouts.length);
    claimInboxSourceCount.inc({ source: "cancellation_recovery" }, refunds.length);

    // ── Aggregate to one position per arena ───────────────────────────────
    const positions = aggregate(walletAddress, payouts, refunds);

    // ── Bounded on-chain verification ─────────────────────────────────────
    const candidates = positions.slice(0, this.deps.maxVerify ?? CLAIM_INBOX_MAX_VERIFY);
    const chainStates = await this.safeVerify(candidates.map((p) => p.arenaId));
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

  /** Refunds never fail the request. */
  private async safeRefunds(walletAddress: string): Promise<ClaimInboxRefundCandidate[]> {
    try {
      return await this.findRefunds(walletAddress);
    } catch (error) {
      logger.error(
        {
          subsystem: "claim-inbox",
          stage: "refund_source",
          error: error instanceof Error ? error.message : "unknown",
        },
        "Cancellation recovery unavailable; serving payout records only",
      );
      return [];
    }
  }

  /**
   * Verify arenas on chain, converting any failure into a recorded
   * `unavailable` rather than an exception.
   *
   * A per-arena failure is isolated: one bad arena id must not make the whole
   * inbox unreadable, because the other items are still actionable.
   */
  private async safeVerify(arenaIds: string[]): Promise<{
    states: Map<string, ClaimInboxArenaState>;
    failedArenas: Set<string>;
    failed: number;
  }> {
    const states = new Map<string, ClaimInboxArenaState>();
    const failedArenas = new Set<string>();
    if (arenaIds.length === 0) return { states, failedArenas, failed: 0 };

    const budget = this.deps.verifyBudgetMs ?? CLAIM_INBOX_VERIFY_BUDGET_MS;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("claim_inbox_verification_timeout")),
        budget,
      );
    });

    try {
      const found = await Promise.race([this.verifyArenas(arenaIds), deadline]);
      for (const [arenaId, state] of found) states.set(arenaId, state);
      // A batch that resolved but omitted an arena did not read that arena
      // successfully. `verifyArenasOnChain` drops exactly the arenas whose RPC
      // threw, so absence is the failure signal — treating it as a silent
      // success would let a position fall through to an arena-state guess and
      // be shown as claimable on no evidence at all.
      for (const arenaId of arenaIds) {
        if (!states.has(arenaId)) failedArenas.add(arenaId);
      }
      if (failedArenas.size > 0) {
        claimInboxVerificationFailures.inc({ reason: "partial" }, failedArenas.size);
        logger.warn(
          {
            subsystem: "claim-inbox",
            stage: "verify",
            failedArenas: failedArenas.size,
            requested: arenaIds.length,
          },
          "Some arena reads failed; affected positions report unavailable",
        );
      }
      return { states, failedArenas, failed: failedArenas.size };
    } catch (error) {
      // The budget is the whole point of "bounded": past it, the chain's
      // answer is not available in time, and the honest response is
      // "unavailable" for every arena that was not already answered.
      for (const arenaId of arenaIds) {
        if (!states.has(arenaId)) failedArenas.add(arenaId);
      }
      claimInboxVerificationFailures.inc({ reason: timeoutReason(error) }, failedArenas.size);
      logger.warn(
        {
          subsystem: "claim-inbox",
          stage: "verify",
          error: error instanceof Error ? error.message : "unknown",
          failedArenas: failedArenas.size,
        },
        "On-chain verification incomplete; affected positions report unavailable",
      );
      return { states, failedArenas, failed: failedArenas.size };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                 */
/* -------------------------------------------------------------------------- */

/** An arena position under construction, before on-chain verification. */
interface Position {
  arenaId: string;
  arenaName: string | null;
  payouts: TransactionRecord[];
  refunds: ClaimInboxRefundCandidate[];
  /** Newest `updatedAt` across sources; the keyset sort key. */
  sortKeyMs: number;
}

/**
 * Fold payout records and refunds into one position per arena.
 *
 * Ownership is enforced here as well as in the queries: a refund candidate
 * whose wallet does not match the caller is dropped rather than filtered
 * upstream, so a bug in a source cannot leak another wallet's balance.
 */
function aggregate(
  walletAddress: string,
  payouts: TransactionRecord[],
  refunds: ClaimInboxRefundCandidate[],
): Position[] {
  const byArena = new Map<string, Position>();

  const position = (arenaId: string): Position => {
    let existing = byArena.get(arenaId);
    if (!existing) {
      existing = { arenaId, arenaName: null, payouts: [], refunds: [], sortKeyMs: 0 };
      byArena.set(arenaId, existing);
    }
    return existing;
  };

  for (const payout of payouts) {
    if (payout.destinationAccount !== walletAddress) continue;
    const entry = position(payout.payoutId);
    entry.payouts.push(payout);
    if (payout.payoutId) entry.arenaName ??= null;
    entry.sortKeyMs = Math.max(entry.sortKeyMs, payout.updatedAt.getTime());
  }

  for (const refund of refunds) {
    if (refund.walletAddress !== walletAddress) continue;
    const entry = position(refund.arenaId);
    entry.refunds.push(refund);
    entry.arenaName ??= refund.arenaName;
    if (refund.updatedAt) {
      entry.sortKeyMs = Math.max(entry.sortKeyMs, refund.updatedAt.getTime());
    }
  }

  // Newest first, with the arena id as a tiebreaker so the order is total and
  // the cursor is deterministic for two positions with the same timestamp.
  return Array.from(byArena.values()).sort((a, b) => {
    const delta = b.sortKeyMs - a.sortKeyMs;
    return delta !== 0 ? delta : a.arenaId.localeCompare(b.arenaId);
  });
}

/* -------------------------------------------------------------------------- */
/* Classification                                                              */
/* -------------------------------------------------------------------------- */

interface BuildItemInput {
  position: Position;
  chainState: ClaimInboxArenaState | null;
  verifiedAt: string;
  nowMs: number;
  assetIssuers: Record<string, string>;
  staleAfterMs: number;
}

/**
 * Decide one position's state.
 *
 * Order matters, and the order is the design:
 *
 *  1. **Verification failure first.** If the chain could not be read, nothing
 *     about the position is knowable, so it is `unavailable` regardless of
 *     what the records say. Deciding from records alone is precisely the
 *     silent-failure bug this service exists to avoid.
 *  2. **A settled component is `completed`** even if another component is not
 *     — the settled part is done and must not be presented as claimable
 *     again, and the incomplete part still gets its own component and reason.
 *  3. **A live in-flight component is `pending`.** The chain decides, not the
 *     user, so there is no action to offer.
 *  4. **A failed component is `blocked`.** A `dead` payout will not be
 *     retried automatically; that needs a human, and saying "not claimable"
 *     would hide it.
 *  5. Only then does a finished arena with no payout become `actionable`.
 */
function buildItem(input: BuildItemInput): ClaimInboxItem {
  const { position, chainState, verifiedAt, nowMs, staleAfterMs, assetIssuers } = input;

  const components: ClaimInboxComponent[] = [
    ...newestFirst(position.payouts).map((payout) => ({
      kind: "winnings" as const,
      asset: assetFor(payout.asset, assetIssuers),
      amountStroops: payout.amountStroops,
      payoutId: payout.payoutId,
      status: payout.status,
      txHash: payout.txHash ?? null,
      confirmedAt: payout.confirmedAt ? payout.confirmedAt.toISOString() : null,
      attempts: payout.attempts,
    })),
    ...position.refunds.map((refund) => ({
      kind: "refund" as const,
      asset: assetFor(refund.assetCode, assetIssuers),
      amountStroops: refund.refundAmountStroops,
      payoutId: null,
      status: refundStatusAsPayment(refund.recoveryStatus),
      txHash: refund.txHash ?? null,
      confirmedAt: refund.confirmedAt ?? null,
      attempts: 0,
    })),
  ];

  const kind: ClaimInboxPositionKind =
    position.payouts.length > 0 && position.refunds.length > 0
      ? "mixed"
      : position.payouts.length > 0
        ? "winnings"
        : "refund";

  const verdict = classify({ position, chainState });

  const recordUpdatedAt = position.sortKeyMs > 0 ? new Date(position.sortKeyMs).toISOString() : null;

  return {
    id: position.arenaId,
    arenaId: position.arenaId,
    arenaName: position.arenaName,
    kind,
    state: verdict.state,
    reason: verdict.reason,
    message: describe(verdict.state, verdict.reason, kind, position),
    components,
    totalsByAsset: totalsByAsset(components),
    freshness: {
      recordUpdatedAt,
      recordAgeSeconds: recordUpdatedAt
        ? Math.max(0, Math.round((nowMs - position.sortKeyMs) / 1000))
        : null,
      stale: position.sortKeyMs > 0 && nowMs - position.sortKeyMs > staleAfterMs,
      ledgerSequence: null,
      verifiedAt,
    },
    action: actionFor(verdict.state, verdict.reason, position),
    sortKey: recordUpdatedAt ?? UNKNOWN_SORT_KEY,
  };
}

interface Verdict {
  state: ClaimInboxState;
  reason: ClaimInboxReason;
}

function classify(input: {
  position: Position;
  chainState: ClaimInboxArenaState | null;
}): Verdict {
  const { position, chainState } = input;
  const payouts = newestFirst(position.payouts);
  const refunds = position.refunds;

  // 1. A refund with no on-chain dependency can still be decided, so it is
  //    read before anything that needs the arena. Refund-only positions never
  //    consult the chain and are never made unavailable by a chain outage.
  if (payouts.length === 0 && refunds.length > 0) {
    return classifyRefundOnly(refunds);
  }

  const live = payouts.find((p) => LIVE_PAYOUT_STATUSES.includes(p.status));
  const failed = payouts.find((p) => p.status === "failed" || p.status === "dead");
  const settled = payouts.find((p) => SETTLED_STATUSES.includes(p.status));
  const unknown = payouts.some((p) => p.status === "unknown");

  // 2. `unknown` means the reconciler gave up, so the local record settles
  //    nothing. Calling it complete would drop real money off the actionable
  //    list, and calling it actionable could invite a second payment for a
  //    payout whose fate is genuinely not known.
  if (unknown) {
    return { state: "unavailable", reason: "unknown" };
  }

  // 3. A settled record is a local claim that the money arrived. Only the
  //    chain can confirm that, so an arena we could not read must not be
  //    presented as completed on the strength of a cached row — that is the
  //    exact shape of "the user refreshed and their payout vanished".
  if (settled && chainState === null) {
    return { state: "unavailable", reason: "rpc_unavailable" };
  }

  // 4. In flight and failed are local facts about our own payment pipeline.
  //    They need no chain read, and a wallet is better served by "your
  //    payment is moving" than by an outage it cannot act on.
  if (live) {
    return { state: "pending", reason: "payout_submitted" };
  }

  if (failed) {
    return { state: "blocked", reason: "payout_failed" };
  }

  if (settled) {
    // A settled winnings component alongside a live refund: the money has
    // arrived, but the refund has not, so the position is still actionable —
    // with the settled component present and marked, so it is not claimed
    // twice.
    const refundLive = refunds.find(
      (r) => r.recoveryStatus === "refundable" || r.recoveryStatus === "submitted",
    );
    if (refundLive) {
      return refundLive.recoveryStatus === "submitted"
        ? { state: "pending", reason: "refund_submitted" }
        : { state: "actionable", reason: "refund_ready" };
    }
    return { state: "completed", reason: "payout_confirmed" };
  }

  if (refunds.length > 0) {
    const refundLive = refunds.find((r) => r.recoveryStatus === "refundable");
    if (refundLive) return { state: "actionable", reason: "refund_ready" };
    const refundInFlight = refunds.find((r) => r.recoveryStatus === "submitted");
    if (refundInFlight) return { state: "pending", reason: "refund_submitted" };
    const refundFailed = refunds.find((r) => r.recoveryStatus === "failed");
    if (refundFailed) return { state: "blocked", reason: "payout_failed" };
    if (refunds.some((r) => r.recoveryStatus === "confirmed")) {
      return { state: "completed", reason: "refund_confirmed" };
    }
  }

  // 5. Arena state decides whether winnings are due at all.
  if (chainState === "Cancelled") {
    // Cancelled with no payout record: a zero-survivor cancellation has
    // nothing to pay. Blocked, and stated as such, rather than left to look
    // like a stuck claim.
    if (refunds.length === 0) {
      return { state: "blocked", reason: "zero_survivor_cancellation" };
    }
  }

  if (chainState === "Finished") {
    // Finished, no payout, no failure: the winnings are claimable now.
    return { state: "actionable", reason: "claim_ready" };
  }

  if (chainState === "Open" || chainState === "InProgress") {
    return { state: "blocked", reason: "arena_not_finished" };
  }

  // chainState is null only when the position was not verified: the read
  // failed, or it was never attempted because the arena was past the
  // verification cap. Say so rather than guessing.
  return { state: "unavailable", reason: "rpc_unavailable" };
}

function classifyRefundOnly(
  refunds: ClaimInboxRefundCandidate[],
): Verdict {
  if (refunds.some((r) => r.recoveryStatus === "refundable")) {
    return { state: "actionable", reason: "refund_ready" };
  }
  if (refunds.some((r) => r.recoveryStatus === "submitted")) {
    return { state: "pending", reason: "refund_submitted" };
  }
  if (refunds.some((r) => r.recoveryStatus === "failed")) {
    return { state: "blocked", reason: "payout_failed" };
  }
  if (refunds.some((r) => r.recoveryStatus === "confirmed")) {
    return { state: "completed", reason: "refund_confirmed" };
  }
  return { state: "unavailable", reason: "unknown" };
}

function newestFirst(payouts: TransactionRecord[]): TransactionRecord[] {
  return [...payouts].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
  );
}

/**
 * Describe an asset for the response.
 *
 * `issuer` is the configured issuer, or null for native XLM. A credit asset
 * with no configured issuer also comes back null: the alternative is guessing
 * an account, and a wrong issuer is worse than a visible gap because a client
 * would build a trustline against it. The counter is how a missing
 * `ASSET_ISSUERS` entry surfaces in production instead of quietly shipping
 * null issuers, and the frontend refuses to build a trustline without its own
 * explicit `NEXT_PUBLIC_*_ISSUER`, so a null here blocks rather than misleads.
 */
function assetFor(code: string, issuers: Record<string, string>): ClaimInboxAsset {
  if (code !== NATIVE_ASSET_CODE && !issuers[code]) {
    claimInboxUnconfiguredAssets.inc({ code });
  }
  return {
    code,
    issuer: code === NATIVE_ASSET_CODE ? null : (issuers[code] ?? null),
    // Stellar assets are 7-decimal on both the classic and Soroban paths.
    decimals: 7,
  };
}

function totalsByAsset(
  components: ClaimInboxComponent[],
): ClaimInboxItem["totalsByAsset"] {
  const byKey = new Map<string, bigint>();
  const issuers = new Map<string, string | null>();
  for (const component of components) {
    const key = `${component.asset.code}:${component.asset.issuer ?? ""}`;
    byKey.set(key, (byKey.get(key) ?? 0n) + BigInt(component.amountStroops));
    issuers.set(key, component.asset.issuer);
  }
  return Array.from(byKey.entries())
    .map(([key, amount]) => ({
      code: key.slice(0, key.indexOf(":")),
      issuer: issuers.get(key) ?? null,
      amountStroops: amount.toString(),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

function refundStatusAsPayment(
  status: ClaimInboxRefundCandidate["recoveryStatus"],
): PaymentStatus {
  switch (status) {
    case "refundable":
      return "built";
    case "submitted":
      return "submitted";
    case "confirmed":
      return "confirmed";
    case "failed":
      return "dead";
  }
}

function actionFor(
  state: ClaimInboxState,
  reason: ClaimInboxReason,
  position: Position,
): ClaimInboxItem["action"] {
  if (state === "actionable") {
    return reason === "refund_ready"
      ? { type: "refund", label: "Claim refund", endpoint: null }
      : { type: "claim", label: "Claim winnings", endpoint: null };
  }
  if (state === "unavailable") {
    // Always retryable: the answer is unknown, not negative.
    return { type: "retry", label: "Check again", endpoint: null };
  }
  if (state === "pending") {
    return { type: "view_history", label: "View pending", endpoint: null };
  }
  if (state === "completed") {
    return { type: "view_history", label: "View receipt", endpoint: null };
  }
  return null;
}

function describe(
  state: ClaimInboxState,
  reason: ClaimInboxReason,
  kind: ClaimInboxPositionKind,
  position: Position,
): string {
  const noun = kind === "refund" ? "refund" : "winnings";
  switch (reason) {
    case "claim_ready":
      return "This arena has finished and your winnings are ready to claim.";
    case "refund_ready":
      return "This arena was cancelled and your stake is ready to be refunded.";
    case "payout_submitted":
      return "Your claim was submitted and is waiting for confirmation.";
    case "refund_submitted":
      return "Your refund was submitted and is waiting for confirmation.";
    case "payout_confirmed":
      return "Your winnings have been paid.";
    case "refund_confirmed":
      return "Your stake has been refunded.";
    case "payout_failed":
      return `The ${noun} transaction did not succeed. It needs support attention before it can be paid.`;
    case "zero_survivor_cancellation":
      return "This arena was cancelled with no survivors, so there is no pot to pay out.";
    case "arena_not_finished":
      return "This arena has not finished yet, so no winnings are due.";
    case "rpc_unavailable":
      return "The network could not be checked, so the current state is unknown. This is not a statement that nothing is owed.";
    case "ledger_lag":
      return "The network is behind, so the current state is not yet final.";
    case "account_not_found":
      return "This wallet does not exist on the configured network yet.";
    case "issuer_unconfigured":
      return "No issuer is configured for this asset, so it cannot be claimed yet.";
    case "not_owned":
      return "This position belongs to a different wallet.";
    case "unknown":
    default:
      return state === "unavailable"
        ? "The current state could not be determined."
        : "No action is available for this position.";
  }
}

function summarize(items: ClaimInboxItem[]): ClaimInboxSummary {
  const summary: ClaimInboxSummary = {
    actionable: 0,
    pending: 0,
    completed: 0,
    blocked: 0,
    unavailable: 0,
    total: items.length,
  };
  for (const item of items) summary[item.state] += 1;
  return summary;
}

/* -------------------------------------------------------------------------- */
/* Cursor                                                                      */
/* -------------------------------------------------------------------------- */

function encodeCursor(cursor: ClaimInboxCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/**
 * Decode a cursor, returning `null` for anything unrecognized.
 *
 * A garbled cursor restarts from the beginning rather than throwing. That is
 * the same choice `playerActivityService` makes, and the reason is that a
 * cursor is not untrusted input in any security sense — it is a pagination
 * convenience, and refusing to serve the inbox over a bad one would turn a
 * cosmetic client bug into a dead endpoint.
 */
function decodeCursor(cursor: string): ClaimInboxCursor | null {
  try {
    const payload = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf-8"),
    ) as Partial<ClaimInboxCursor>;
    if (typeof payload.sortKey !== "string" || typeof payload.id !== "string") {
      return null;
    }
    if (Number.isNaN(Date.parse(payload.sortKey))) return null;
    return { sortKey: payload.sortKey, id: payload.id };
  } catch {
    return null;
  }
}

function timeoutReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("timeout")) return "timeout";
  return "error";
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
