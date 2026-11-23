/**
 * Payments & Transactions Metrics Domain (#1750)
 */

import {
  createCounter,
  createGauge,
  createHistogram,
} from "../registry";

// Transaction Metrics
export const txsConfirmedTotal = createCounter(
  {
    name: "txs_confirmed_total",
    help: "Total number of confirmed transactions",
    labelNames: ["status"],
  },
  { domain: "payments" },
);

export const txConfirmEnqueuedTotal = createCounter(
  {
    name: "inversearena_tx_confirm_enqueued_total",
    help: "Total tx-confirm jobs enqueued onto the BullMQ queue by PaymentService (#1602)",
  },
  { domain: "payments" },
);

export const txConfirmWaitHistogram = createHistogram(
  {
    name: "inversearena_tx_confirm_enqueue_wait_seconds",
    help: "Time spent waiting for the BullMQ add() call to resolve when enqueuing a tx-confirm job (#1602)",
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  },
  { domain: "payments" },
);

export const payoutsSuccessTotal = createCounter(
  {
    name: "inversearena_payouts_success_total",
    help: "Total successful prize payouts",
    labelNames: ["asset"],
  },
  { domain: "payments" },
);

export const payoutsDeadLetterTotal = createCounter(
  {
    name: "inversearena_payouts_dead_letter_total",
    help: "Total payouts moved to dead status after exhausting failed retries",
    labelNames: ["reason"],
  },
  { domain: "payments" },
);

// Transaction intent metrics (#1381)
export const intentCreatedTotal = createCounter(
  {
    name: "inversearena_intent_created_total",
    help: "Total transaction intents created (excludes idempotent resumes)",
    labelNames: ["kind"],
  },
  { domain: "payments" },
);

export const intentResumedTotal = createCounter(
  {
    name: "inversearena_intent_resumed_total",
    help: "Total transaction intents resumed from an existing unexpired record",
    labelNames: ["kind"],
  },
  { domain: "payments" },
);

export const intentOutcomeTotal = createCounter(
  {
    name: "inversearena_intent_outcome_total",
    help: "Total transaction intents reaching a terminal or retry-relevant status",
    labelNames: ["kind", "status"],
  },
  { domain: "payments" },
);

export const intentSignRetryTotal = createCounter(
  {
    name: "inversearena_intent_sign_retry_total",
    help: "Total times an intent was resubmitted for signing after a rejection or expiry",
    labelNames: ["kind", "reason"],
  },
  { domain: "payments" },
);

export const intentLatencySeconds = createHistogram(
  {
    name: "inversearena_intent_latency_seconds",
    help: "Time from intent creation to a terminal status (confirmed, failed, or expired)",
    labelNames: ["kind", "status"],
    buckets: [1, 5, 15, 30, 60, 120, 300],
  },
  { domain: "payments" },
);

export const diagnosticsRunsTotal = createCounter(
  {
    name: "inversearena_transaction_diagnostics_runs_total",
    help: "Total transaction simulation diagnostics runs, by outcome",
    labelNames: ["outcome"],
  },
  { domain: "payments" },
);

export const diagnosticsRunDuration = createHistogram(
  {
    name: "inversearena_transaction_diagnostics_duration_seconds",
    help: "Transaction simulation diagnostics duration in seconds",
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  },
  { domain: "payments" },
);

export const transactionAccessDecisionsTotal = createCounter(
  {
    name: "inversearena_transaction_access_decisions_total",
    help: "Transaction/payout status access decisions, by operation, outcome and reason",
    labelNames: ["operation", "outcome", "reason"],
  },
  { domain: "payments" },
);

// Claim and refund inbox (#1489)
export const claimInboxScanDuration = createHistogram(
  {
    name: "claim_inbox_scan_duration_seconds",
    help: "Wall-clock time to assemble one claim-inbox page, including the bounded on-chain read",
    labelNames: ["result"],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  },
  { domain: "payments" },
);

export const claimInboxVerificationFailures = createCounter(
  {
    name: "claim_inbox_verification_failures_total",
    help: "On-chain verification failures during a claim-inbox scan, by reason",
    labelNames: ["reason"],
  },
  { domain: "payments" },
);

export const claimInboxItemCount = createCounter(
  {
    name: "claim_inbox_items_total",
    help: "Claim-inbox items served, by state",
    labelNames: ["state"],
  },
  { domain: "payments" },
);

export const claimInboxSourceCount = createCounter(
  {
    name: "claim_inbox_source_records_total",
    help: "Records read per claim-inbox scan, by source",
    labelNames: ["source"],
  },
  { domain: "payments" },
);

export const claimInboxUnconfiguredAssets = createCounter(
  {
    name: "claim_inbox_unconfigured_asset_total",
    help: "Claim-inbox components whose asset code has no configured issuer",
    labelNames: ["code"],
  },
  { domain: "payments" },
);

export const claimInboxActionableItems = createGauge(
  {
    name: "claim_inbox_actionable_items",
    help: "Actionable claim-inbox items in the most recently served page",
    labelNames: [],
  },
  { domain: "payments" },
);

export const activeStakeLimitBlockedTotal = createCounter(
  {
    name: "active_stake_limit_blocked_total",
    help: "Total active stake limit blocked checks",
    labelNames: ["reason"],
  },
  { domain: "payments" },
);

export const activeStakeCurrentGauge = createGauge(
  {
    name: "active_stake_current_usdc",
    help: "Current active stake per user",
    labelNames: ["user_id"],
  },
  { domain: "payments" },
);

export const feeEligibilityIssuedTotal = createCounter(
  {
    name: "fee_eligibility_issued_total",
    help: "Total number of fee sponsorship eligibilities issued",
  },
  { domain: "payments" },
);

export const feeEligibilityConsumedTotal = createCounter(
  {
    name: "fee_eligibility_consumed_total",
    help: "Total number of fee sponsorship eligibilities consumed",
  },
  { domain: "payments" },
);

export const feeEligibilityExpiredTotal = createCounter(
  {
    name: "fee_eligibility_expired_total",
    help: "Total number of fee sponsorship eligibilities expired",
  },
  { domain: "payments" },
);
