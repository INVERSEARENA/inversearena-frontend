import { z } from "zod";
import type { EnvVarSpec } from "../envSpec";
import { accountId, contractId, csv, decimal, flag, int, isoTimestamp, kid, rateLimit, rotation, secretSeed, text, url } from "../envSpec";

export const workerEnvVars = {
  TX_WORKER_CONCURRENCY: {
    section: "Workers",
    description: "Concurrent jobs in the transaction reconciler.",
    example: "1",
    default: "1",
    schema: int(1),
  },
  TX_RECONCILER_CONCURRENCY: {
    section: "Workers",
    description: "Legacy alias of TX_WORKER_CONCURRENCY, read only when that is unset.",
    schema: int(1),
  },
  TX_WORKER_CAPACITY: {
    section: "Workers",
    description: "Legacy alias of TX_WORKER_CONCURRENCY, read only when both others are unset.",
    schema: int(1),
  },
  INTENT_TTL_MS: {
    section: "Workers",
    description: "Lifetime of a transaction intent before it expires (#1381).",
    default: "300000",
    schema: int(1),
  },
  INTENT_MAX_SIGN_ATTEMPTS: { section: "Workers", description: "Signing attempts per intent.", default: "5", schema: int(1) },
  TREASURY_DESTINATION: {
    section: "Workers",
    description:
      "Expected fee-collection address for treasury reconciliation (#1511). Leave unset until fee collection is wired up on-chain.",
    schema: text,
  },
  TREASURY_FINALITY_GRACE_SECONDS: {
    section: "Workers",
    description: "Seconds after a ledger closes before an unmatched fee is reported as a discrepancy.",
    example: "120",
    default: "120",
    schema: int(1),
  },
  TTL_KEEPER_MANIFESTS: {
    section: "Workers",
    description: "JSON array of deployment manifests for `npm run ttl:plan`.",
    schema: z.string().refine((value) => {
      try {
        return Array.isArray(JSON.parse(value));
      } catch {
        return false;
      }
    }, "must be a JSON array"),
  },
  TTL_KEEPER_RENEW_BELOW_LEDGERS: { section: "Workers", description: "Renew entries whose TTL is below this many ledgers.", schema: int(1) },
  TTL_KEEPER_MAX_RENEWALS_PER_RUN: { section: "Workers", description: "Renewal cap per `ttl:plan` run.", schema: int(1) },
  TTL_KEEPER_MAX_RENEWALS_PER_CONTRACT: { section: "Workers", description: "Renewal cap per contract per run.", schema: int(1) },
  PARTITION_AHEAD_MONTHS: {
    section: "Workers",
    description:
      "Monthly partitions to keep created ahead of the current month for the partitioned high-volume tables (#1622).",
    default: "3",
    schema: int(0, 120),
  },
  RETENTION_TRANSACTIONS_ARCHIVE_AFTER_MONTHS: {
    section: "Workers",
    description:
      "Age after which a `transactions` monthly partition is moved to the cold archive schema by the retention worker (#1622).",
    default: "13",
    schema: int(1, 1200),
  },
  RETENTION_ELIMINATION_LOGS_ARCHIVE_AFTER_MONTHS: {
    section: "Workers",
    description:
      "Age after which an `elimination_logs` monthly partition is moved to the cold archive schema by the retention worker (#1622).",
    default: "13",
    schema: int(1, 1200),
  },
  SYBIL_FUNDING_HOPS: {
    section: "Workers",
    description: "Funding-graph BFS depth scanned by the sybil detection worker.",
    default: "2",
    schema: int(1, 20),
  },
  SYBIL_COOCCURRENCE_MIN: {
    section: "Workers",
    description: "Minimum shared arenas before a common-funder co-occurrence signal is recorded.",
    default: "3",
    schema: int(1),
  },
  SYBIL_TIMING_WINDOW_MS: {
    section: "Workers",
    description: "Commit-timing burst window in milliseconds for sybil detection.",
    default: "2000",
    schema: int(1),
  },
  SYBIL_RISK_THRESHOLD: {
    section: "Workers",
    description: "Minimum composite sybil score required to write a flag.",
    default: "0.6",
    schema: decimal(0, 1),
  },
  SYBIL_FUNDING_ALLOWLIST: {
    section: "Workers",
    description: "Comma-separated exchange/funder addresses exempt from sybil funding-graph flags.",
    schema: csv(text, "address"),
  },
  VAULT_WARN_COVERAGE_RATIO: {
    section: "Workers",
    description: "Vault coverage ratio at which a warning is emitted by the shortfall monitor.",
    default: "1.05",
    schema: decimal(0, 1_000),
  },
  VAULT_CRIT_COVERAGE_RATIO: {
    section: "Workers",
    description: "Vault coverage ratio at which a critical alert is emitted by the shortfall monitor.",
    default: "1.00",
    schema: decimal(0, 1_000),
  },
  VAULT_ALERT_DEDUP_MS: {
    section: "Workers",
    description: "Deduplication window for vault shortfall alerts in milliseconds.",
    default: "300000",
    schema: int(1),
  },
  VAULT_CHECK_INTERVAL_MS: {
    section: "Workers",
    description: "Vault coverage check interval in milliseconds.",
    default: "60000",
    schema: int(1),
  }
} satisfies Record<string, EnvVarSpec>;
