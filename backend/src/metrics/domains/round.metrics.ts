/**
 * Round & Arena Lifecycle Metrics Domain (#1750)
 */

import {
  createCounter,
  createHistogram,
} from "../registry";

// Round Metrics
export const roundResolutionsTotal = createCounter(
  {
    name: "round_resolutions_total",
    help: "Total number of round resolutions",
    labelNames: ["status"],
  },
  { domain: "round" },
);

export const roundResolutionDuration = createHistogram(
  {
    name: "round_resolution_duration_seconds",
    help: "Round resolution duration in seconds",
    labelNames: ["status"],
    buckets: [0.1, 0.5, 1, 2, 5, 10],
  },
  { domain: "round" },
);

export const arenaStateTransitionsTotal = createCounter(
  {
    name: "inversearena_arena_state_transitions_total",
    help: "Total number of arena round state transitions",
    labelNames: ["from_state", "to_state"],
  },
  { domain: "round" },
);

export const playersEliminatedTotal = createCounter(
  {
    name: "inversearena_players_eliminated_total",
    help: "Total players eliminated across all arenas",
  },
  { domain: "round" },
);

// Commit receipt status endpoint (#1383)
export const commitReceiptLookupsTotal = createCounter(
  {
    name: "inversearena_commit_receipt_lookups_total",
    help: "Total commit-status lookups, by resulting status and outcome",
    labelNames: ["status", "outcome"],
  },
  { domain: "round" },
);

export const commitReceiptLookupDuration = createHistogram(
  {
    name: "inversearena_commit_receipt_lookup_duration_seconds",
    help: "Commit-status lookup duration in seconds",
    buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2],
  },
  { domain: "round" },
);

// Arena lifecycle command idempotency (#1386)
export const lifecycleCommandOutcomeTotal = createCounter(
  {
    name: "inversearena_lifecycle_command_outcome_total",
    help: "Total arena lifecycle command outcomes by action and result",
    labelNames: ["action", "outcome"],
  },
  { domain: "round" },
);

export const lifecycleCommandDurationSeconds = createHistogram(
  {
    name: "inversearena_lifecycle_command_duration_seconds",
    help: "Duration of a freshly-executed (non-replayed) arena lifecycle command",
    labelNames: ["action"],
    buckets: [0.1, 0.5, 1, 2, 5, 15, 30, 60],
  },
  { domain: "round" },
);

// Round proof bundle metrics (#1394)
export const proofBundleAssemblyTotal = createCounter(
  {
    name: "inversearena_proof_bundle_assembly_total",
    help: "Total round proof bundle assembly attempts",
    labelNames: ["status"],
  },
  { domain: "round" },
);

export const proofBundleAssemblyDuration = createHistogram(
  {
    name: "inversearena_proof_bundle_assembly_duration_seconds",
    help: "Round proof bundle assembly duration in seconds",
    buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2],
  },
  { domain: "round" },
);

export const proofBundleAssemblyRetriesTotal = createCounter(
  {
    name: "inversearena_proof_bundle_assembly_retries_total",
    help: "Total retry attempts made while assembling a round proof bundle",
  },
  { domain: "round" },
);

export const proofBundleVerificationTotal = createCounter(
  {
    name: "inversearena_proof_bundle_verification_total",
    help: "Total client-side (frontend-reported) proof bundle verification outcomes",
    labelNames: ["status"],
  },
  { domain: "round" },
);

// Dispute evidence package metrics (#1517)
export const evidencePackageGenerationTotal = createCounter(
  {
    name: "inversearena_evidence_package_generation_total",
    help: "Total dispute evidence package generation attempts",
    labelNames: ["status"],
  },
  { domain: "round" },
);

export const evidencePackageGenerationDuration = createHistogram(
  {
    name: "inversearena_evidence_package_generation_duration_seconds",
    help: "Dispute evidence package generation duration in seconds",
    buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2],
  },
  { domain: "round" },
);

// #1523: Typed Round Metadata Persistence & Dual-Read Mismatch Metrics
export const roundMetadataMismatchesTotal = createCounter(
  {
    name: "inversearena_round_metadata_mismatches_total",
    help: "Total round metadata dual-read mismatches detected between typed columns and legacy json",
    labelNames: ["field"],
  },
  { domain: "round" },
);

export const roundMetadataBackfillTotal = createCounter(
  {
    name: "inversearena_round_metadata_backfill_total",
    help: "Total rounds processed by metadata normalization backfill, by status",
    labelNames: ["status"],
  },
  { domain: "round" },
);
