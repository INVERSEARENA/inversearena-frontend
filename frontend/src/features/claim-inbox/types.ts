/**
 * Claim and refund inbox contract (#1489).
 *
 * Mirrors `backend/src/types/claimInbox.ts`. The backend proves the two halves
 * agree with compile-time assertions over its own Zod schemas; this file is the
 * client half of that contract and is validated at runtime with `safeParse` so
 * a server that grows a field, or a proxy that rewrites one, surfaces as an
 * explicit parse error rather than as `undefined` rendered into a balance.
 *
 * ## Rules this file encodes for callers
 *
 * **Amounts are stroop strings.** `amountStroops` is a decimal string and must
 * be converted through `bigint` — never `Number` — because a pot above 2^53
 * stroops is representable as a string and silently wrong as a double.
 *
 * **`unavailable` is not `completed`.** A failed on-chain read yields
 * `unavailable`, which must render as an explicit unknown the user can retry.
 * Collapsing it into "nothing to do" is the failure this endpoint exists to
 * prevent.
 *
 * **`message` and `action.label` are safe to render verbatim.** The backend
 * builds both without a wallet address, so they can be shown without a
 * separate string table. There is no i18n layer in this app.
 *
 * @module
 */

import { z } from "zod";

export const claimInboxStateSchema = z.enum([
  "actionable",
  "pending",
  "completed",
  "blocked",
  "unavailable",
]);

export type ClaimInboxState = z.infer<typeof claimInboxStateSchema>;

export const claimInboxReasonSchema = z.enum([
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

export type ClaimInboxReason = z.infer<typeof claimInboxReasonSchema>;

/**
 * Stroops as a decimal string.
 *
 * Validated as digits so a number arriving from a misconfigured proxy is
 * rejected at the boundary rather than becoming `NaN` in a balance.
 */
export const stroopsSchema = z.string().regex(/^\d+$/, "Stroop amounts are unsigned decimal strings");

export const claimInboxAssetSchema = z.object({
  code: z.string(),
  /** Issuer for a credit asset, `null` for native XLM. */
  issuer: z.string().nullable(),
  decimals: z.literal(7),
});

export const claimInboxComponentSchema = z.object({
  kind: z.enum(["winnings", "refund"]),
  asset: claimInboxAssetSchema,
  amountStroops: stroopsSchema,
  payoutId: z.string().nullable(),
  status: z.string().nullable(),
  txHash: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
});

export const claimInboxItemSchema = z.object({
  id: z.string(),
  arenaId: z.string(),
  arenaName: z.string().nullable(),
  kind: z.enum(["winnings", "refund", "mixed"]),
  state: claimInboxStateSchema,
  reason: claimInboxReasonSchema,
  message: z.string(),
  components: z.array(claimInboxComponentSchema),
  totalsByAsset: z.array(
    z.object({ code: z.string(), issuer: z.string().nullable(), amountStroops: stroopsSchema }),
  ),
  freshness: z.object({
    recordUpdatedAt: z.string().nullable(),
    recordAgeSeconds: z.number().int().nullable(),
    stale: z.boolean(),
    ledgerSequence: z.number().int().nullable(),
    verifiedAt: z.string(),
  }),
  action: z
    .object({
      type: z.enum(["claim", "refund", "retry", "view_history"]),
      label: z.string(),
      /** Backend path that drives this action, or `null` if client-side. */
      endpoint: z.string().nullable(),
    })
    .nullable(),
  sortKey: z.string(),
});

export const claimInboxPageSchema = z.object({
  version: z.literal(1),
  walletAddress: z.string(),
  items: z.array(claimInboxItemSchema),
  summary: z.object({
    actionable: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  cursor: z.string().nullable(),
  hasMore: z.boolean(),
  /** `false` means at least one chain read failed or was skipped. */
  verificationComplete: z.boolean(),
  scanLatencyMs: z.number().int().nonnegative(),
  sources: z.object({
    payouts: z.number().int().nonnegative(),
    cancellationRecovery: z.number().int().nonnegative(),
  }),
});

export type ClaimInboxAsset = z.infer<typeof claimInboxAssetSchema>;
export type ClaimInboxComponent = z.infer<typeof claimInboxComponentSchema>;
export type ClaimInboxItem = z.infer<typeof claimInboxItemSchema>;
export type ClaimInboxPage = z.infer<typeof claimInboxPageSchema>;
export type ClaimInboxSummary = z.infer<typeof claimInboxPageSchema>["summary"];
