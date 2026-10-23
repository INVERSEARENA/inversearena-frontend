import { processEnv } from "./env";
export const DEFAULT_TX_WORKER_CONCURRENCY = 1;
export const DEFAULT_PARTITION_AHEAD_MONTHS = 3;
export const DEFAULT_TRANSACTIONS_ARCHIVE_AFTER_MONTHS = 13;
export const DEFAULT_ELIMINATION_LOGS_ARCHIVE_AFTER_MONTHS = 13;

export interface TxWorkerConfig {
  concurrency: number;
  capacity: number;
}

/** Tuning for the retention/partition-maintenance worker (#1622). */
export interface RetentionConfig {
  /** How many future monthly partitions to keep created per managed table. */
  partitionAheadMonths: number;
  /** Move a `transactions` partition to the archive schema once older than this. */
  transactionsArchiveAfterMonths: number;
  /** Move an `elimination_logs` partition to the archive schema once older than this. */
  eliminationLogsArchiveAfterMonths: number;
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function optionalInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  parse: (value: string | undefined, name: string) => number,
): number {
  return value === undefined ? fallback : parse(value, name);
}

export function getTxWorkerConfig(
  env: NodeJS.ProcessEnv = processEnv,
): TxWorkerConfig {
  const value =
    env.TX_WORKER_CONCURRENCY ??
    env.TX_RECONCILER_CONCURRENCY ??
    env.TX_WORKER_CAPACITY ??
    String(DEFAULT_TX_WORKER_CONCURRENCY);
  const concurrency = positiveInteger(value, "TX_WORKER_CONCURRENCY");
  return { concurrency, capacity: concurrency };
}

export function getRetentionConfig(
  env: NodeJS.ProcessEnv = processEnv,
): RetentionConfig {
  return {
    partitionAheadMonths: optionalInteger(
      env.PARTITION_AHEAD_MONTHS,
      DEFAULT_PARTITION_AHEAD_MONTHS,
      "PARTITION_AHEAD_MONTHS",
      nonNegativeInteger,
    ),
    transactionsArchiveAfterMonths: optionalInteger(
      env.RETENTION_TRANSACTIONS_ARCHIVE_AFTER_MONTHS,
      DEFAULT_TRANSACTIONS_ARCHIVE_AFTER_MONTHS,
      "RETENTION_TRANSACTIONS_ARCHIVE_AFTER_MONTHS",
      positiveInteger,
    ),
    eliminationLogsArchiveAfterMonths: optionalInteger(
      env.RETENTION_ELIMINATION_LOGS_ARCHIVE_AFTER_MONTHS,
      DEFAULT_ELIMINATION_LOGS_ARCHIVE_AFTER_MONTHS,
      "RETENTION_ELIMINATION_LOGS_ARCHIVE_AFTER_MONTHS",
      positiveInteger,
    ),
  };
}
