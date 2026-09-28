/**
 * Claim and refund inbox types (#1489).
 *
 * The inbox is the authoritative, wallet-scoped answer to "does this wallet
 * have money it can move, and if so what exactly do I press?". It replaces the
 * per-arena `claim-readiness` round trip with a single call, and it merges
 * three sources that previously had to be consulted separately and could
 * disagree: Mongo payout records, PostgreSQL cancellation recovery, and
 * on-chain arena state.
 *
 * ## Design rules these types encode
 *
 * **One item per arena.** A wallet that won a pot *and* has a refundable
 * stake in the same arena gets one item with two components, not two rows.
 * Two rows would make the same position look claimable twice, and the user
 * would sign twice.
 *
 * **`unavailable` is a first-class state.** A failed on-chain read is not
 * "not claimable" and not a zero amount. It is a distinct state carrying a
 * typed reason and a retry action, because the alternative is that a transient
 * RPC outage silently presents a claimable payout as nothing to do — and the
 * user only discovers the money when it is gone.
 *
 * **Amounts are stroop strings.** `amountStroops` is a `string`, never a
 * `number`. A pot that exceeds 2^53 stroops is representable as a string and
 * silently wrong as a float, and this is a balance.
 *
 * @module
 */

import type { PaymentStatus, TransactionRecord } from "./payment";
import { z } from "../openapi/zodOpenApi";

/**
 * Where a position came from.
 *
 * `winnings` is a pot the wallet won. `refund` is a stake returned because
 * the arena was cancelled. `mixed` is both, and carries a component for each.
 */
export type ClaimInboxPositionKind = "winnings" | "refund" | "mixed";

/**
 * The state of a position, from the wallet's point of view.
 *
 * `actionable` — there is a next action the user can take right now.
 * `pending`    — a transaction is in flight; the chain decides.
 * `completed`  — settled. Retained in history, never actionable.
 * `blocked`    — known, and the wallet cannot act on it. Carries a reason
 *                that is a property of the position, not a transient failure
 *                (a failed payout, a cancellation with no survivors).
 * `unavailable`— the answer is unknown because a read failed. Carries a
 *                retry action and is *never* collapsed into `completed` or
 *                `actionable`.
 */
export type ClaimInboxState =
  | "actionable"
  | "pending"
  | "completed"
  | "blocked"
  | "unavailable";

/**
 * Typed reason for the state.
 *
 * A closed set, so the client can branch exhaustively and the metric
 * cardinality is bounded. `unknown` is reserved for a reason this version
 * does not name, which is why it is present rather than omitted.
 */
export type ClaimInboxReason =
  /** Winnings, arena finished, no payout created yet. */
  | "claim_ready"
  /** Cancellation refund owed, not yet submitted. */
  | "refund_ready"
  /** A payout exists and is signed/submitted; awaiting confirmation. */
  | "payout_submitted"
  /** A refund was submitted; awaiting confirmation. */
  | "refund_submitted"
  /** A payout confirmed on chain. */
  | "payout_confirmed"
  /** A refund confirmed on chain. */
  | "refund_confirmed"
  /** Payout exhausted its attempts; will not be retried automatically. */
  | "payout_failed"
  /** Cancellation produced no survivors, so there is nothing to pay out. */
  | "zero_survivor_cancellation"
  /** The arena has not finished, so no winnings are due yet. */
  | "arena_not_finished"
  /** On-chain read failed; the true state is unknown. */
  | "rpc_unavailable"
  /** The on-chain state was readable but behind the wallet's expectation. */
  | "ledger_lag"
  /** The wallet account does not exist on the configured network. */
  | "account_not_found"
  /** The issuer for the payout asset is not configured. */
  | "issuer_unconfigured"
  /** A record the wallet does not own was referenced; never expected. */
  | "not_owned"
  /** The reason is not one this version names. */
  | "unknown";

/** Asset identity, including the issuer. */
export interface ClaimInboxAsset {
  code: string;
  /**
   * Issuer public key for a credit asset, `null` for native XLM. Present
   * because an amount without an issuer is not actionable: a `changeTrust`
   * is keyed by the exact pair.
   */
  issuer: string | null;
  /**
   * Stellar assets have exactly 7 decimals. Kept explicit — and typed as the
   * literal, not `number`, so the published schema and the type agree.
   */
  decimals: 7;
}

/**
 * One money movement inside a position.
 *
 * A position can hold several: a pot in USDC and a cancelled stake in XLM are
 * different assets and cannot be signed in one transaction.
 */
export interface ClaimInboxComponent {
  kind: "winnings" | "refund";
  asset: ClaimInboxAsset;
  /** Exact amount in stroops, as a decimal string. */
  amountStroops: string;
  /** `null` when no payout record exists yet. */
  payoutId: string | null;
  /** `null` when no payout record exists yet. */
  status: PaymentStatus | null;
  txHash: string | null;
  confirmedAt: string | null;
  /** Attempts made, for a `payout_failed` explanation. */
  attempts: number;
}

/** Freshness of the underlying records, and of the chain read. */
export interface ClaimInboxFreshness {
  /** Most recent `updatedAt` across the position's records. */
  recordUpdatedAt: string | null;
  /** Seconds between `recordUpdatedAt` and now. `null` when unknown. */
  recordAgeSeconds: number | null;
  /**
   * `true` when the position is being decided by a record older than the
   * staleness threshold. Surfaced so a client can show "as of 4 minutes ago"
   * instead of implying the state is current.
   */
  stale: boolean;
  /** Ledger sequence the on-chain read was taken at, `null` if unread. */
  ledgerSequence: number | null;
  /** When this response's chain read happened, ISO-8601. */
  verifiedAt: string;
}

/** The single next step, or `null` when there is nothing to press. */
export interface ClaimInboxAction {
  type: "claim" | "refund" | "retry" | "view_history";
  /** Label safe to render verbatim. */
  label: string;
  /**
   * Backend endpoint to drive this action, `null` for client-side actions.
   * Deliberately a path the app already exposes rather than a new write
   * surface: the inbox aggregates, it does not move funds.
   */
  endpoint: string | null;
}

/** One wallet position in one arena. */
export interface ClaimInboxItem {
  /**
   * Stable identity: the arena id. One item per arena per wallet, which is
   * what makes a duplicate arena impossible rather than merely unlikely.
   */
  id: string;
  arenaId: string;
  arenaName: string | null;
  kind: ClaimInboxPositionKind;
  state: ClaimInboxState;
  reason: ClaimInboxReason;
  /** Human-readable explanation. Contains no wallet address. */
  message: string;
  components: ClaimInboxComponent[];
  /**
   * Sum across components, per asset code, in stroops. Present because a
   * position can span assets and a single total would be meaningless.
   */
  totalsByAsset: Array<{ code: string; issuer: string | null; amountStroops: string }>;
  freshness: ClaimInboxFreshness;
  action: ClaimInboxAction | null;
  /**
   * Sort key: the position's most recent activity, ISO-8601. This is the
   * keyset the cursor is built on, and it is derived from the position's own
   * records rather than from "now" — a key derived from read time would
   * reshuffle on every request and no cursor could ever be stable.
   */
  sortKey: string;
}

/** Counts by state, so the dashboard can render a summary without scanning. */
export interface ClaimInboxSummary {
  actionable: number;
  pending: number;
  completed: number;
  blocked: number;
  unavailable: number;
  total: number;
}

export interface ClaimInboxPage {
  version: 1;
  /** Echoed for the client to correlate; not a privacy boundary. */
  walletAddress: string;
  items: ClaimInboxItem[];
  summary: ClaimInboxSummary;
  /** Keyset cursor for the next page, `null` at the end. */
  cursor: string | null;
  hasMore: boolean;
  /** Whether the chain read was complete; `false` means items may be stale. */
  verificationComplete: boolean;
  /** Wall-clock cost of the chain read, for the client's own diagnostics. */
  scanLatencyMs: number;
  /** Sources that contributed, so a client can explain a thin inbox. */
  sources: {
    payouts: number;
    cancellationRecovery: number;
  };
}

/**
 * Lifecycle state of an arena contract, as the inbox needs it.
 *
 * Declared here rather than imported from `onChainReader`, which reaches
 * across into the frontend package for its RPC gateway. The backend
 * `tsconfig` cannot compile that file at all — it lives outside `rootDir` and
 * uses path aliases the backend does not define — so importing it would make
 * the inbox unbuildable and untestable. This union is the only part the inbox
 * actually depends on, and restating it keeps the dependency on a type.
 */
export type ClaimInboxArenaState = "Open" | "InProgress" | "Finished" | "Cancelled";

/** Page metadata carried on a decoded cursor. */
export interface ClaimInboxCursor {
  sortKey: string;
  id: string;
}

/** A raw payout record narrowed to what the inbox needs. */
export type ClaimInboxPayout = Pick<
  TransactionRecord,
  | "id"
  | "payoutId"
  | "destinationAccount"
  | "asset"
  | "amountStroops"
  | "status"
  | "txHash"
  | "confirmedAt"
  | "attempts"
  | "createdAt"
  | "updatedAt"
>;

/* -------------------------------------------------------------------------- */
/* Runtime schemas                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Zod mirrors of the types above, used to publish the contract in OpenAPI.
 *
 * The interfaces are the source of truth for the service; these exist because
 * OpenAPI needs schemas at runtime. The assertions at the bottom of this file
 * fail compilation if the two ever drift, so a field added to one and not the
 * other cannot reach a release unnoticed.
 */
export const ClaimInboxPositionKindSchema = z.enum(["winnings", "refund", "mixed"]);

export const ClaimInboxStateSchema = z.enum([
  "actionable",
  "pending",
  "completed",
  "blocked",
  "unavailable",
]);

export const ClaimInboxReasonSchema = z.enum([
  "claim_ready",
  "refund_ready",
  "payout_submitted",
  "refund_submitted",
  "payout_confirmed",
  "refund_confirmed",
  "payout_failed",
  "zero_survivor_cancellation",
  "arena_not_finished",
  "rpc_unavailable",
  "ledger_lag",
  "account_not_found",
  "issuer_unconfigured",
  "not_owned",
  "unknown",
]);

/**
 * Stroops as a decimal string.
 *
 * Published as a string with a numeric pattern because a 64-bit balance is not
 * representable as a JSON number: a client parsing this as a double would
 * silently lose precision on exactly the largest pots.
 */
export const StroversSchema = z
  .string()
  .regex(/^\d+$/, "Stroop amounts are unsigned decimal strings");

export const ClaimInboxAssetSchema = z.object({
  code: z.string(),
  issuer: z.string().nullable(),
  decimals: z.literal(7),
});

/**
 * Payment status, mirroring `PaymentStatus`.
 *
 * The union is repeated rather than derived because the drift assertion below
 * is what proves the two agree; deriving one from the other would make the
 * check meaningless.
 */
export const PaymentStatusSchema = z.enum([
  "built",
  "queued",
  "awaiting_signature",
  "submitted",
  "confirmed",
  "failed",
  "dead",
  "unknown",
]);

export const ClaimInboxComponentSchema = z.object({
  kind: z.enum(["winnings", "refund"]),
  asset: ClaimInboxAssetSchema,
  amountStroops: StroversSchema,
  payoutId: z.string().nullable(),
  status: PaymentStatusSchema.nullable(),
  txHash: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
});

export const ClaimInboxFreshnessSchema = z.object({
  recordUpdatedAt: z.string().nullable(),
  recordAgeSeconds: z.number().int().nullable(),
  stale: z.boolean(),
  ledgerSequence: z.number().int().nullable(),
  verifiedAt: z.string(),
});

export const ClaimInboxActionSchema = z.object({
  type: z.enum(["claim", "refund", "retry", "view_history"]),
  label: z.string(),
  endpoint: z.string().nullable(),
});

export const ClaimInboxItemSchema = z.object({
  id: z.string(),
  arenaId: z.string(),
  arenaName: z.string().nullable(),
  kind: ClaimInboxPositionKindSchema,
  state: ClaimInboxStateSchema,
  reason: ClaimInboxReasonSchema,
  message: z.string(),
  components: z.array(ClaimInboxComponentSchema),
  totalsByAsset: z.array(
    z.object({ code: z.string(), issuer: z.string().nullable(), amountStroops: StroversSchema }),
  ),
  freshness: ClaimInboxFreshnessSchema,
  action: ClaimInboxActionSchema.nullable(),
  sortKey: z.string(),
});

export const ClaimInboxSummarySchema = z.object({
  actionable: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const ClaimInboxPageSchema = z.object({
  version: z.literal(1),
  walletAddress: z.string(),
  items: z.array(ClaimInboxItemSchema),
  summary: ClaimInboxSummarySchema,
  cursor: z.string().nullable(),
  hasMore: z.boolean(),
  verificationComplete: z.boolean(),
  scanLatencyMs: z.number().int().nonnegative(),
  sources: z.object({
    payouts: z.number().int().nonnegative(),
    cancellationRecovery: z.number().int().nonnegative(),
  }),
});

export const ClaimInboxQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(512).optional(),
});

/* -------------------------------------------------------------------------- */
/* Drift guards                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Compile-time proof that each published schema still describes its interface.
 *
 * Assignability is checked in *both* directions, so a field added to only one
 * side fails. `Assert<T extends true>` is what makes the check bite: the
 * obvious `type Extends<A, B> = B extends A ? true : never` formulation is
 * silently satisfied by `never`, and would have passed no matter how far the
 * two had drifted.
 */
type Exact<Interface, Inferred> = [Inferred] extends [Interface]
  ? [Interface] extends [Inferred]
    ? true
    : false
  : false;
type Assert<T extends true> = T;

export type _Asset = Assert<Exact<ClaimInboxAsset, z.infer<typeof ClaimInboxAssetSchema>>>;
export type _Component = Assert<
  Exact<ClaimInboxComponent, z.infer<typeof ClaimInboxComponentSchema>>
>;
export type _Freshness = Assert<
  Exact<ClaimInboxFreshness, z.infer<typeof ClaimInboxFreshnessSchema>>
>;
export type _Action = Assert<Exact<ClaimInboxAction, z.infer<typeof ClaimInboxActionSchema>>>;
export type _Item = Assert<Exact<ClaimInboxItem, z.infer<typeof ClaimInboxItemSchema>>>;
export type _Summary = Assert<Exact<ClaimInboxSummary, z.infer<typeof ClaimInboxSummarySchema>>>;
export type _Page = Assert<Exact<ClaimInboxPage, z.infer<typeof ClaimInboxPageSchema>>>;
export type _Kind = Assert<
  Exact<ClaimInboxPositionKind, z.infer<typeof ClaimInboxPositionKindSchema>>
>;
export type _State = Assert<Exact<ClaimInboxState, z.infer<typeof ClaimInboxStateSchema>>>;
export type _Reason = Assert<Exact<ClaimInboxReason, z.infer<typeof ClaimInboxReasonSchema>>>;
export type _PaymentStatus = Assert<Exact<PaymentStatus, z.infer<typeof PaymentStatusSchema>>>;
