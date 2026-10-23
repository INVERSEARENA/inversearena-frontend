import type { PrismaClient } from "@prisma/client";
import { NonceModel } from "../db/models/nonce.model";
import { RefreshTokenModel } from "../db/models/refreshToken.model";
import { TransactionIntentModel } from "../db/models/transactionIntent.model";
import {
  getRetentionConfig,
  type RetentionConfig,
} from "../config/workerConfig";
import { logger } from "../utils/logger";
import {
  retentionRunsTotal,
  retentionRunDurationSeconds,
  retentionPartitionsCreatedTotal,
  retentionPartitionsArchivedTotal,
  retentionEphemeralDeletedTotal,
  retentionHotPartitions,
} from "../utils/metrics";

/** Cold schema aged monthly partitions are moved into (#1622). */
export const ARCHIVE_SCHEMA = "archive";

/** One RANGE-partitioned table owned by the retention worker. */
export interface ManagedPartitionedTable {
  table: string;
  /** Which retention window applies to this table. */
  archiveAfterMonths: (config: RetentionConfig) => number;
}

/**
 * The partitioned tables created by migration
 * `20261020000000_partition_high_volume_tables`. Names are the same
 * identifiers Prisma manages via @@map, and are the only table names ever
 * interpolated into the worker's raw DDL — everything else is parameterised.
 */
export const MANAGED_PARTITIONED_TABLES: readonly ManagedPartitionedTable[] = [
  {
    table: "elimination_logs",
    archiveAfterMonths: (config) => config.eliminationLogsArchiveAfterMonths,
  },
  {
    table: "transactions",
    archiveAfterMonths: (config) => config.transactionsArchiveAfterMonths,
  },
];

/** Monthly partition name convention shared with the migration. */
const PARTITION_NAME_PATTERN = /^(.+)_p(\d{4})_(\d{2})$/;
/** Belt-and-braces guard before any identifier reaches interpolated DDL. */
const SAFE_IDENT = /^[a-z][a-z0-9_]*$/;
const SAFE_MONTH_DATE = /^\d{4}-\d{2}-01$/;

export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** Month arithmetic on a UTC month boundary; safe because inputs are day-1. */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

export function partitionName(table: string, month: string): string {
  return `${table}_p${month.replace("-", "_")}`;
}

export interface EphemeralCounts {
  nonces: number;
  refreshTokens: number;
  transactionIntents: number;
}

const ZERO_COUNTS = (): EphemeralCounts => ({
  nonces: 0,
  refreshTokens: 0,
  transactionIntents: 0,
});

/**
 * Count/delete ephemeral Mongo documents whose expiry has passed. Injected
 * into the worker so unit tests can exercise the orchestration without a
 * MongoDB; production uses {@link MongoEphemeralRetentionStore}.
 */
export interface EphemeralRetentionStore {
  countExpired(now: Date): Promise<EphemeralCounts>;
  deleteExpired(now: Date): Promise<EphemeralCounts>;
}

/**
 * Production ephemeral store: expired auth nonces and refresh tokens
 * (both already carry Mongo TTL indexes as a best-effort backstop — this
 * store makes cleanup deterministic and observable), plus expired
 * transaction intents ("transient tx attempts", #1622).
 */
export class MongoEphemeralRetentionStore implements EphemeralRetentionStore {
  async countExpired(now: Date): Promise<EphemeralCounts> {
    const [nonces, refreshTokens, transactionIntents] = await Promise.all([
      NonceModel.countDocuments({ expiresAt: { $lt: now } }),
      RefreshTokenModel.countDocuments({ expiresAt: { $lt: now } }),
      TransactionIntentModel.countDocuments({ status: "expired", expiresAt: { $lt: now } }),
    ]);
    return { nonces, refreshTokens, transactionIntents };
  }

  async deleteExpired(now: Date): Promise<EphemeralCounts> {
    const [nonces, refreshTokens, transactionIntents] = await Promise.all([
      NonceModel.deleteMany({ expiresAt: { $lt: now } }),
      RefreshTokenModel.deleteMany({ expiresAt: { $lt: now } }),
      TransactionIntentModel.deleteMany({ status: "expired", expiresAt: { $lt: now } }),
    ]);
    return {
      nonces: nonces.deletedCount,
      refreshTokens: refreshTokens.deletedCount,
      transactionIntents: transactionIntents.deletedCount,
    };
  }
}

export interface RetentionRunOptions {
  /** Plan and report every action without executing any DDL/DML. */
  dryRun?: boolean;
  /** Injectable clock for tests. */
  now?: Date;
}

export interface RetentionRunResult {
  status: "success" | "failed";
  dryRun: boolean;
  durationMs: number;
  createdPartitions: Array<{ table: string; name: string }>;
  archivedPartitions: Array<{ table: string; name: string }>;
  ephemeralDeleted: EphemeralCounts;
  /** Expected operational conditions (e.g. a partition bound overlapping the
   * default partition) — reported, but not a failed run. */
  warnings: string[];
  /** Unexpected failures; make the run's status "failed". */
  errors: string[];
}

export interface RetentionWorkerOptions {
  config?: RetentionConfig;
  ephemeralStore?: EphemeralRetentionStore;
}

/**
 * Partition maintenance + retention for the high-volume tables (#1622).
 *
 * Responsibilities per run:
 *   1. Ensure monthly partitions exist `PARTITION_AHEAD_MONTHS` ahead of the
 *      current month for each managed table, so inserts never fail on a
 *      missing partition.
 *   2. Move monthly partitions older than the table's retention window into
 *      the cold `archive` schema. Audit/ledger history is never deleted —
 *      only detached from the hot parent and moved to cold storage. See
 *      docs/PARTITION_RETENTION_RUNBOOK.md for restore procedures.
 *   3. Delete expired ephemeral Mongo documents (auth nonces, refresh
 *      tokens, expired transaction intents).
 *
 * Every step supports dry-run: nothing is executed, but the exact actions
 * are computed, reported in the result and counted via metrics with
 * `mode="planned"`.
 *
 * Follows ArenaBackfillWorker's shape: a plain class with a `run()` entry
 * point, no BullMQ/cron — triggered by the admin-gated HTTP endpoint
 * (`POST /api/worker/retention/run`) on an external schedule.
 */
export class RetentionWorker {
  private readonly config: RetentionConfig;
  private readonly ephemeralStore: EphemeralRetentionStore;
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaClient,
    options: RetentionWorkerOptions = {},
  ) {
    this.config = options.config ?? getRetentionConfig();
    this.ephemeralStore = options.ephemeralStore ?? new MongoEphemeralRetentionStore();
  }

  /**
   * Runs one retention pass. A concurrent call while a run is in progress
   * returns immediately with a zero-action success, mirroring
   * ArenaBackfillWorker's single-flight guard.
   */
  async run(options: RetentionRunOptions = {}): Promise<RetentionRunResult> {
    if (this.isRunning) {
      logger.warn(
        "RetentionWorker.run: run already in progress, skipping concurrent execution",
      );
      return {
        status: "success",
        dryRun: options.dryRun ?? false,
        durationMs: 0,
        createdPartitions: [],
        archivedPartitions: [],
        ephemeralDeleted: ZERO_COUNTS(),
        warnings: [],
        errors: [],
      };
    }

    this.isRunning = true;
    const startedAt = Date.now();
    const dryRun = options.dryRun ?? false;
    const mode = dryRun ? "planned" : "applied";
    const now = options.now ?? new Date();

    const createdPartitions: RetentionRunResult["createdPartitions"] = [];
    const archivedPartitions: RetentionRunResult["archivedPartitions"] = [];
    const warnings: string[] = [];
    const errors: string[] = [];

    try {
      for (const managed of MANAGED_PARTITIONED_TABLES) {
        try {
          await this.ensureFuturePartitions(managed, { dryRun, mode, now, createdPartitions, warnings });
        } catch (error) {
          errors.push(`${managed.table}: future-partition check failed: ${String(error)}`);
        }
        try {
          await this.archiveAgedPartitions(managed, { dryRun, mode, now, archivedPartitions, warnings });
        } catch (error) {
          errors.push(`${managed.table}: archive pass failed: ${String(error)}`);
        }
      }

      let ephemeralDeleted = ZERO_COUNTS();
      try {
        ephemeralDeleted = dryRun
          ? await this.ephemeralStore.countExpired(now)
          : await this.ephemeralStore.deleteExpired(now);
        retentionEphemeralDeletedTotal.inc({ collection: "nonces", mode }, ephemeralDeleted.nonces);
        retentionEphemeralDeletedTotal.inc({ collection: "refresh_tokens", mode }, ephemeralDeleted.refreshTokens);
        retentionEphemeralDeletedTotal.inc({ collection: "transaction_intents", mode }, ephemeralDeleted.transactionIntents);
      } catch (error) {
        errors.push(`ephemeral cleanup failed: ${String(error)}`);
      }

      for (const warning of warnings) {
        logger.warn({ event: "retention_warning", warning }, "RetentionWorker.run: warning");
      }
      for (const error of errors) {
        logger.error({ event: "retention_error", error }, "RetentionWorker.run: error");
      }

      const status: RetentionRunResult["status"] = errors.length > 0 ? "failed" : "success";
      const durationMs = Date.now() - startedAt;
      retentionRunsTotal.inc({ status });
      retentionRunDurationSeconds.observe(durationMs / 1000);

      logger.info(
        {
          status,
          dryRun,
          createdPartitions: createdPartitions.length,
          archivedPartitions: archivedPartitions.length,
          ephemeralDeleted,
          warnings: warnings.length,
          errors: errors.length,
          durationMs,
        },
        "RetentionWorker.run: retention pass complete",
      );

      return {
        status,
        dryRun,
        durationMs,
        createdPartitions,
        archivedPartitions,
        ephemeralDeleted,
        warnings,
        errors,
      };
    } finally {
      this.isRunning = false;
    }
  }

  /** Child partitions currently attached to a managed parent. */
  async listPartitions(table: string): Promise<string[]> {
    assertSafeIdent(table);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ relname: string }>>(
      `SELECT c.relname
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
       JOIN pg_namespace n ON n.oid = p.relnamespace
       WHERE n.nspname = current_schema() AND p.relname = $1`,
      table,
    );
    return rows.map((row) => row.relname);
  }

  private async ensureFuturePartitions(
    managed: ManagedPartitionedTable,
    ctx: {
      dryRun: boolean;
      mode: "applied" | "planned";
      now: Date;
      createdPartitions: RetentionRunResult["createdPartitions"];
      warnings: string[];
    },
  ): Promise<void> {
    const { table } = managed;
    const existing = new Set(await this.listPartitions(table));

    const months: string[] = [monthKey(ctx.now)];
    for (let i = 1; i <= this.config.partitionAheadMonths; i += 1) {
      months.push(monthKey(addMonths(ctx.now, i)));
    }

    for (const month of months) {
      const name = partitionName(table, month);
      if (existing.has(name)) continue;

      if (ctx.dryRun) {
        ctx.createdPartitions.push({ table, name });
        retentionPartitionsCreatedTotal.inc({ table, mode: ctx.mode });
        logger.info(
          { table, partition: name },
          "RetentionWorker.ensureFuturePartitions: would create partition (dry-run)",
        );
        continue;
      }

      const start = `${month}-01`;
      const end = `${monthKey(addMonths(new Date(`${start}T00:00:00Z`), 1))}-01`;
      assertSafeIdent(name);
      assertSafeIdent(table);
      if (!SAFE_MONTH_DATE.test(start) || !SAFE_MONTH_DATE.test(end)) {
        ctx.warnings.push(`${table}: refusing to create partition with unvalidated bounds ${start}..${end}`);
        continue;
      }

      try {
        await this.prisma.$executeRawUnsafe(
          `CREATE TABLE ${quoteIdent(name)} PARTITION OF ${quoteIdent(table)} FOR VALUES FROM ('${start}') TO ('${end}')`,
        );
        ctx.createdPartitions.push({ table, name });
        retentionPartitionsCreatedTotal.inc({ table, mode: ctx.mode });
        logger.info({ table, partition: name }, "RetentionWorker.ensureFuturePartitions: created partition");
      } catch (error) {
        // Most common cause: the DEFAULT partition holds rows inside the new
        // partition's range. Reported as a warning so operators can fix the
        // data placement (see the runbook) without paging on every run.
        ctx.warnings.push(
          `${table}: could not create partition ${name} (is the default partition holding in-range rows?): ${String(error)}`,
        );
      }
    }

    const hotCount = [...existing].filter((name) => PARTITION_NAME_PATTERN.test(name)).length +
      ctx.createdPartitions.filter((p) => p.table === table && !ctx.dryRun).length;
    retentionHotPartitions.set({ table }, hotCount);
  }

  private async archiveAgedPartitions(
    managed: ManagedPartitionedTable,
    ctx: {
      dryRun: boolean;
      mode: "applied" | "planned";
      now: Date;
      archivedPartitions: RetentionRunResult["archivedPartitions"];
      warnings: string[];
    },
  ): Promise<void> {
    const { table } = managed;
    const archiveAfterMonths = managed.archiveAfterMonths(this.config);
    const cutoffMonth = monthKey(addMonths(monthStart(ctx.now), -archiveAfterMonths));
    const partitions = await this.listPartitions(table);

    for (const name of partitions) {
      const match = PARTITION_NAME_PATTERN.exec(name);
      if (!match || match[1] !== table) continue; // skips `<table>_p_default` and unknown shapes
      const month = `${match[2]}-${match[3]}`;
      if (month >= cutoffMonth) continue; // still inside the retention window

      if (ctx.dryRun) {
        ctx.archivedPartitions.push({ table, name });
        retentionPartitionsArchivedTotal.inc({ table, mode: ctx.mode });
        logger.info(
          { table, partition: name, cutoffMonth },
          "RetentionWorker.archiveAgedPartitions: would archive partition (dry-run)",
        );
        continue;
      }

      if (await this.relationExistsInArchive(name)) {
        ctx.warnings.push(
          `${table}: skipping ${name} — a relation with that name already exists in the ${ARCHIVE_SCHEMA} schema`,
        );
        continue;
      }

      assertSafeIdent(name);
      assertSafeIdent(table);
      assertSafeIdent(ARCHIVE_SCHEMA);
      await this.prisma.$transaction([
        this.prisma.$executeRawUnsafe(
          `ALTER TABLE ${quoteIdent(table)} DETACH PARTITION ${quoteIdent(name)}`,
        ),
        this.prisma.$executeRawUnsafe(
          `ALTER TABLE ${quoteIdent(name)} SET SCHEMA ${quoteIdent(ARCHIVE_SCHEMA)}`,
        ),
      ]);
      ctx.archivedPartitions.push({ table, name });
      retentionPartitionsArchivedTotal.inc({ table, mode: ctx.mode });
      logger.info(
        { table, partition: name, cutoffMonth },
        "RetentionWorker.archiveAgedPartitions: moved partition to cold archive",
      );
    }
  }

  private async relationExistsInArchive(name: string): Promise<boolean> {
    assertSafeIdent(name);
    assertSafeIdent(ARCHIVE_SCHEMA);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ one: number }>>(
      `SELECT 1 AS one
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      ARCHIVE_SCHEMA,
      name,
    );
    return rows.length > 0;
  }
}

function assertSafeIdent(value: string): void {
  if (!SAFE_IDENT.test(value)) {
    throw new Error(`Refusing to use unsafe SQL identifier: ${value}`);
  }
}

/** Identifiers are pre-validated against SAFE_IDENT; interpolation is safe. */
function quoteIdent(value: string): string {
  assertSafeIdent(value);
  return `"${value}"`;
}
