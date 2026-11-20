import type { PaymentStatus, TransactionRecord } from "../types/payment";
import type {
  ClaimInboxAsset, ClaimInboxComponent, ClaimInboxCursor, ClaimInboxItem,
  ClaimInboxPositionKind, ClaimInboxReason, ClaimInboxState, ClaimInboxSummary,
  ClaimInboxArenaState,
} from "../types/claimInbox";
import { claimInboxUnconfiguredAssets } from "../utils/metrics";
import type { ClaimInboxRefundCandidate } from "./claimInboxService";

const LIVE_PAYOUT_STATUSES: PaymentStatus[] = ["queued", "awaiting_signature", "submitted"];
const SETTLED_STATUSES: PaymentStatus[] = ["confirmed"];
const UNKNOWN_SORT_KEY = "1970-01-01T00:00:00.000Z";
const NATIVE_ASSET_CODE = "XLM";

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                 */
/* -------------------------------------------------------------------------- */

/** An arena position under construction, before on-chain verification. */
export interface Position {
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
export function aggregate(
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

export interface BuildItemInput {
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
export function buildItem(input: BuildItemInput): ClaimInboxItem {
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

export function summarize(items: ClaimInboxItem[]): ClaimInboxSummary {
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

export function encodeCursor(cursor: ClaimInboxCursor): string {
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
export function decodeCursor(cursor: string): ClaimInboxCursor | null {
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

