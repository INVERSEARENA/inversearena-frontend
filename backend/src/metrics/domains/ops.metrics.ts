/**
 * Operations, Audit, Retention & Diagnostics Metrics Domain (#1750)
 */

import {
  createCounter,
  createGauge,
  createHistogram,
} from "../registry";

export const serverTimeIssuedTotal = createCounter(
  {
    name: "inversearena_server_time_issued_total",
    help: "Total signed server-time tokens issued",
  },
  { domain: "ops" },
);

export const serverTimeVerifiedTotal = createCounter(
  {
    name: "inversearena_server_time_verified_total",
    help: "Total signed server-time token verification attempts, by outcome",
    labelNames: ["outcome"],
  },
  { domain: "ops" },
);

export const watchlistOperationsTotal = createCounter(
  {
    name: "inversearena_watchlist_operations_total",
    help: "Total arena watchlist watch/unwatch operations, by operation and result",
    labelNames: ["operation", "result"],
  },
  { domain: "ops" },
);

// #1501: dashboard bootstrap composition
export const dashboardBootstrapTotal = createCounter(
  {
    name: "inversearena_dashboard_bootstrap_total",
    help: "Dashboard bootstrap requests, by outcome (ok/partial/error)",
    labelNames: ["outcome"],
  },
  { domain: "ops" },
);

export const dashboardBootstrapSectionDuration = createHistogram(
  {
    name: "inversearena_dashboard_bootstrap_section_duration_seconds",
    help: "Per-section latency of the dashboard bootstrap composition, by section and state",
    labelNames: ["section", "state"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  },
  { domain: "ops" },
);

export const dashboardBootstrapSectionFailures = createCounter(
  {
    name: "inversearena_dashboard_bootstrap_section_failures_total",
    help: "Dashboard bootstrap sections that failed or timed out, by section and reason",
    labelNames: ["section", "reason"],
  },
  { domain: "ops" },
);

// #1503: tamper-evident administrative audit chain
export const auditAppendsTotal = createCounter(
  {
    name: "inversearena_audit_appends_total",
    help: "Chained audit record appends, by outcome (ok/conflict/error)",
    labelNames: ["outcome"],
  },
  { domain: "ops" },
);

export const auditChainVerificationTotal = createCounter(
  {
    name: "inversearena_audit_chain_verification_total",
    help: "Audit chain verification runs, by outcome (valid/invalid/error)",
    labelNames: ["outcome"],
  },
  { domain: "ops" },
);

export const auditCheckpointsTotal = createCounter(
  {
    name: "inversearena_audit_checkpoints_total",
    help: "Signed audit chain checkpoints persisted, by outcome (ok/error)",
    labelNames: ["outcome"],
  },
  { domain: "ops" },
);

export const auditChainProtectionGauge = createGauge(
  {
    name: "inversearena_audit_chain_protection_available",
    help: "Audit chain protection availability: 1=fully protected, 0=degraded",
  },
  { domain: "ops" },
);

export const maintenanceMutationsBlockedTotal = createCounter(
  {
    name: "inversearena_maintenance_mutations_blocked_total",
    help: "Total mutating requests rejected because a maintenance window was active",
    labelNames: ["method"],
  },
  { domain: "ops" },
);

export const maintenanceWindowsScheduledTotal = createCounter(
  {
    name: "inversearena_maintenance_windows_scheduled_total",
    help: "Total maintenance windows scheduled, by outcome",
    labelNames: ["status"],
  },
  { domain: "ops" },
);

export const payloadLimitRejectionsTotal = createCounter(
  {
    name: "inversearena_payload_limit_rejections_total",
    help: "Untrusted payloads rejected by schema-level size/depth limits, by boundary and limit kind",
    labelNames: ["boundary", "limit"],
  },
  { domain: "ops" },
);

export const secretKeyVerificationsTotal = createCounter(
  {
    name: "inversearena_secret_key_verifications_total",
    help: "JWT/webhook signature verifications during key rotation, by purpose, matched key slot and outcome",
    labelNames: ["purpose", "slot", "outcome"],
  },
  { domain: "ops" },
);

// #1490: ledger rollback detection and recovery
export const ledgerRollbackDepth = createHistogram(
  {
    name: "inversearena_ledger_rollback_depth_ledgers",
    help: "Depth of a detected ledger rollback, in ledgers",
    buckets: [1, 2, 5, 10, 25, 50, 100, 500, 1000],
  },
  { domain: "ops" },
);

export const ledgerRollbackRecoveryDuration = createHistogram(
  {
    name: "inversearena_ledger_rollback_recovery_duration_seconds",
    help: "Time from rollback detection until continuity was re-verified",
    buckets: [1, 5, 15, 30, 60, 120, 300, 900, 3600],
  },
  { domain: "ops" },
);

export const ledgerRollbackAffectedConsumersTotal = createCounter(
  {
    name: "inversearena_ledger_rollback_affected_consumers_total",
    help: "Consumers notified of a ledger rollback or gap, or deferred by one",
    labelNames: ["consumer"],
  },
  { domain: "ops" },
);

// Arena Discovery Backfill Metrics (#1391)
export const backfillRunsTotal = createCounter(
  {
    name: "inversearena_backfill_runs_total",
    help: "Total arena discovery backfill runs",
    labelNames: ["status"],
  },
  { domain: "ops" },
);

export const backfillArenasDiscoveredTotal = createCounter(
  {
    name: "inversearena_backfill_arenas_discovered_total",
    help: "Total arenas successfully upserted by the backfill job",
  },
  { domain: "ops" },
);

export const backfillArenasFailedTotal = createCounter(
  {
    name: "inversearena_backfill_arenas_failed_total",
    help: "Total arenas whose backfill upsert failed and will be retried next run",
  },
  { domain: "ops" },
);

export const backfillRunDurationSeconds = createHistogram(
  {
    name: "inversearena_backfill_run_duration_seconds",
    help: "Arena discovery backfill run duration in seconds",
    buckets: [0.5, 1, 2, 5, 10, 30, 60],
  },
  { domain: "ops" },
);

export const backfillCursorPosition = createGauge(
  {
    name: "inversearena_backfill_cursor_position",
    help: "Last pool_id fully processed by the arena discovery backfill cursor",
  },
  { domain: "ops" },
);

// #1622: Partitioning & retention worker metrics
export const retentionRunsTotal = createCounter(
  {
    name: "inversearena_retention_runs_total",
    help: "Total retention worker runs, by outcome",
    labelNames: ["status"],
  },
  { domain: "ops" },
);

export const retentionRunDurationSeconds = createHistogram(
  {
    name: "inversearena_retention_run_duration_seconds",
    help: "Retention worker run duration in seconds",
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  },
  { domain: "ops" },
);

export const retentionPartitionsCreatedTotal = createCounter(
  {
    name: "inversearena_retention_partitions_created_total",
    help: "Monthly partitions created ahead of time, by table and mode (applied|planned)",
    labelNames: ["table", "mode"],
  },
  { domain: "ops" },
);

export const retentionPartitionsArchivedTotal = createCounter(
  {
    name: "inversearena_retention_partitions_archived_total",
    help: "Monthly partitions moved to the cold archive schema, by table and mode (applied|planned)",
    labelNames: ["table", "mode"],
  },
  { domain: "ops" },
);

export const retentionEphemeralDeletedTotal = createCounter(
  {
    name: "inversearena_retention_ephemeral_deleted_total",
    help: "Expired ephemeral documents removed, by collection and mode (applied|planned)",
    labelNames: ["collection", "mode"],
  },
  { domain: "ops" },
);

export const retentionHotPartitions = createGauge(
  {
    name: "inversearena_retention_hot_partitions",
    help: "Monthly partitions currently attached to each hot partitioned table",
    labelNames: ["table"],
  },
  { domain: "ops" },
);

// #1525: Database Query Budgets & Slow Query Attribution Metrics
export const dbQueryBudgetViolationsTotal = createCounter(
  {
    name: "inversearena_db_query_budget_violations_total",
    help: "Total database query budget violations by route, datastore, and violation type",
    labelNames: ["route", "datastore", "violation_type"],
  },
  { domain: "ops" },
);

export const dbQueryDurationSeconds = createHistogram(
  {
    name: "inversearena_db_query_duration_seconds",
    help: "Normalized database query execution duration in seconds",
    labelNames: ["datastore"],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  },
  { domain: "ops" },
);

export const dbQueryCountPerRequest = createHistogram(
  {
    name: "inversearena_db_query_count_per_request",
    help: "Total database queries executed per HTTP request/job by route",
    labelNames: ["route"],
    buckets: [1, 2, 5, 10, 20, 50, 100],
  },
  { domain: "ops" },
);

// #1512: Oracle freshness policy enforcement
export const oracleFreshnessClassificationTotal = createCounter(
  {
    name: "inversearena_oracle_freshness_classification_total",
    help: "Oracle reading freshness classifications (fresh/warning/stale/unavailable)",
    labelNames: ["classification"],
  },
  { domain: "ops" },
);

export const oracleStalenessSecondsGauge = createGauge(
  {
    name: "inversearena_oracle_staleness_seconds",
    help: "Age in seconds of the most recently classified oracle observation, per oracle contract",
    labelNames: ["oracle_contract"],
  },
  { domain: "ops" },
);

export const yieldDependentActionsBlockedTotal = createCounter(
  {
    name: "inversearena_yield_dependent_actions_blocked_total",
    help: "Yield-dependent mutations rejected for stale/unavailable oracle data, by action and reason",
    labelNames: ["action", "reason"],
  },
  { domain: "ops" },
);

/** Creator Operations Console metrics (#1509) */
export const creatorActionOutcomesTotal = createCounter(
  {
    name: "creator_action_outcomes_total",
    help: "Outcomes of creator lifecycle and recovery operations",
    labelNames: ["action", "status"],
  },
  { domain: "ops" },
);

export const creatorStateConflictsTotal = createCounter(
  {
    name: "creator_state_conflicts_total",
    help: "Stale-state conflicts encountered during creator actions",
    labelNames: ["action", "reason"],
  },
  { domain: "ops" },
);

export const ttlKeeperHeadroomLedgers = createGauge(
  {
    name: "ttl_keeper_headroom_ledgers",
    help: "TTL keeper headroom in ledgers",
    labelNames: ["contract", "key"],
  },
  { domain: "ops" },
);

export const ttlKeeperIdentifyFailuresTotal = createCounter(
  {
    name: "ttl_keeper_identify_failures_total",
    help: "TTL keeper identify failures total",
    labelNames: ["contract", "reason"],
  },
  { domain: "ops" },
);

export const ttlKeeperRenewalsTotal = createCounter(
  {
    name: "ttl_keeper_renewals_total",
    help: "TTL keeper renewals total",
    labelNames: ["contract", "status", "reason"],
  },
  { domain: "ops" },
);

export const ttlKeeperConfirmationLagSeconds = createHistogram(
  {
    name: "ttl_keeper_confirmation_lag_seconds",
    help: "TTL keeper confirmation lag in seconds",
    labelNames: ["contract"],
  },
  { domain: "ops" },
);

export const cacheRequestsTotal = createCounter(
  {
    name: "cache_requests_total",
    help: "Total cache requests by namespace and result (hit or miss)",
    labelNames: ["namespace", "result"],
  },
  { domain: "ops" },
);
