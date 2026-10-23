/**
 * Unit tests for RetentionWorker (#1622).
 *
 * Uses a hand-rolled in-memory fake for the Prisma raw-SQL surface the
 * worker touches ($queryRawUnsafe / $executeRawUnsafe / $transaction) —
 * same pattern as arenaBackfillWorker.unit.test.ts — plus an injected
 * ephemeral store, so these tests exercise the worker's own orchestration
 * (create-ahead, archival cutoffs, dry-run semantics, failure handling)
 * without a real PostgreSQL or MongoDB.
 */
import {
  RetentionWorker,
  monthKey,
  monthStart,
  addMonths,
  partitionName,
  type EphemeralCounts,
  type EphemeralRetentionStore,
} from "../../src/workers/retentionWorker";
import { getRetentionConfig } from "../../src/config/workerConfig";

const NOW = new Date("2026-10-15T12:00:00Z");
const CONFIG = {
  partitionAheadMonths: 2,
  transactionsArchiveAfterMonths: 13,
  eliminationLogsArchiveAfterMonths: 13,
};

/** In-memory fake of the raw-SQL surface the worker uses. */
function fakePrisma(initialPartitions: Record<string, string[]> = {}) {
  const partitions: Record<string, string[]> = Object.fromEntries(
    Object.entries(initialPartitions).map(([table, names]) => [table, [...names]]),
  );
  const ddlExecuted: string[] = [];
  const archiveRelations = new Set<string>();
  let failCreateMatching: RegExp | null = null;

  const run = async (sql: string): Promise<number> => {
    let match = /^CREATE TABLE "([^"]+)" PARTITION OF "([^"]+)" FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)$/.exec(sql);
    if (match) {
      if (failCreateMatching && failCreateMatching.test(match[1])) {
        throw new Error("conflicting partition bound value");
      }
      (partitions[match[2]] ??= []).push(match[1]);
      ddlExecuted.push(sql);
      return 1;
    }
    match = /^ALTER TABLE "([^"]+)" DETACH PARTITION "([^"]+)"$/.exec(sql);
    if (match) {
      partitions[match[1]] = (partitions[match[1]] ?? []).filter((p) => p !== match[2]);
      ddlExecuted.push(sql);
      return 1;
    }
    match = /^ALTER TABLE "([^"]+)" SET SCHEMA "([^"]+)"$/.exec(sql);
    if (match) {
      archiveRelations.add(match[1]);
      ddlExecuted.push(sql);
      return 1;
    }
    throw new Error(`fakePrisma: unexpected DDL: ${sql}`);
  };

  const prisma = {
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      if (sql.includes("pg_inherits")) {
        const table = params[0] as string;
        return (partitions[table] ?? []).map((relname) => ({ relname }));
      }
      if (sql.includes("pg_class") && sql.includes("pg_namespace")) {
        const [schema, name] = params as [string, string];
        if (schema === "archive" && archiveRelations.has(name)) return [{ one: 1 }];
        return [];
      }
      throw new Error(`fakePrisma: unexpected query: ${sql}`);
    },
    // PrismaPromise-like laziness: nothing executes until awaited (or handed
    // to $transaction), matching the real client's behaviour.
    $executeRawUnsafe: (sql: string) => ({
      then: (
        onFulfilled?: (value: number) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => run(sql).then(onFulfilled, onRejected),
    }),
    $transaction: async (ops: Array<PromiseLike<number>>) => {
      const results: number[] = [];
      for (const op of ops) results.push(await op);
      return results;
    },
  };

  return {
    prisma,
    partitions,
    ddlExecuted,
    archiveRelations,
    failCreateFor(name: RegExp) {
      failCreateMatching = name;
    },
  };
}

function fakeEphemeralStore(
  counts: EphemeralCounts = { nonces: 5, refreshTokens: 3, transactionIntents: 2 },
) {
  const calls: string[] = [];
  const store: EphemeralRetentionStore = {
    countExpired: async () => {
      calls.push("count");
      return counts;
    },
    deleteExpired: async () => {
      calls.push("delete");
      return counts;
    },
  };
  return { store, calls };
}

const INITIAL: Record<string, string[]> = {
  elimination_logs: [
    "elimination_logs_p2024_12", // 22 months old → past the 13-month cutoff
    "elimination_logs_p2026_09",
    "elimination_logs_p2026_10",
    "elimination_logs_p_default",
  ],
  transactions: [
    "transactions_p2025_01", // 19 months old → past the cutoff
    "transactions_p2026_10",
    "transactions_p_default",
  ],
};

function workerWith(
  fake: ReturnType<typeof fakePrisma>,
  ephemeral: ReturnType<typeof fakeEphemeralStore>,
) {
  return new RetentionWorker(fake.prisma as never, {
    config: CONFIG,
    ephemeralStore: ephemeral.store,
  });
}

describe("RetentionWorker helpers", () => {
  it("computes UTC month keys, month starts and partition names", () => {
    expect(monthKey(NOW)).toBe("2026-10");
    expect(monthStart(NOW).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(monthKey(addMonths(monthStart(NOW), -13))).toBe("2025-09");
    expect(partitionName("elimination_logs", "2026-12")).toBe("elimination_logs_p2026_12");
  });
});

describe("RetentionWorker.run", () => {
  it("dry-run reports every planned action without executing DDL or deletions", async () => {
    const fake = fakePrisma(INITIAL);
    const ephemeral = fakeEphemeralStore();
    const worker = workerWith(fake, ephemeral);

    const result = await worker.run({ dryRun: true, now: NOW });

    expect(result.status).toBe("success");
    expect(result.dryRun).toBe(true);
    expect(fake.ddlExecuted).toEqual([]);
    expect(ephemeral.calls).toEqual(["count"]);
    // create-ahead: current month exists, next 2 months missing per table
    expect(result.createdPartitions.map((p) => p.name).sort()).toEqual([
      "elimination_logs_p2026_11",
      "elimination_logs_p2026_12",
      "transactions_p2026_11",
      "transactions_p2026_12",
    ]);
    expect(result.archivedPartitions.map((p) => p.name).sort()).toEqual([
      "elimination_logs_p2024_12",
      "transactions_p2025_01",
    ]);
    expect(result.ephemeralDeleted).toEqual({
      nonces: 5,
      refreshTokens: 3,
      transactionIntents: 2,
    });
    expect(result.errors).toEqual([]);
  });

  it("applies create-ahead and archival, and deletes expired ephemeral documents", async () => {
    const fake = fakePrisma(INITIAL);
    const ephemeral = fakeEphemeralStore();
    const worker = workerWith(fake, ephemeral);

    const result = await worker.run({ now: NOW });

    expect(result.status).toBe("success");
    expect(result.dryRun).toBe(false);
    expect(ephemeral.calls).toEqual(["delete"]);

    expect(fake.ddlExecuted).toContainEqual(
      'CREATE TABLE "elimination_logs_p2026_11" PARTITION OF "elimination_logs" FOR VALUES FROM (\'2026-11-01\') TO (\'2026-12-01\')',
    );
    expect(fake.ddlExecuted).toContainEqual(
      'CREATE TABLE "transactions_p2026_12" PARTITION OF "transactions" FOR VALUES FROM (\'2026-12-01\') TO (\'2027-01-01\')',
    );
    expect(fake.ddlExecuted).toContainEqual(
      'ALTER TABLE "elimination_logs" DETACH PARTITION "elimination_logs_p2024_12"',
    );
    expect(fake.ddlExecuted).toContainEqual(
      'ALTER TABLE "elimination_logs_p2024_12" SET SCHEMA "archive"',
    );
    expect(fake.ddlExecuted).toContainEqual(
      'ALTER TABLE "transactions" DETACH PARTITION "transactions_p2025_01"',
    );

    // partitions are attached/detached in the fake state
    expect(fake.partitions.elimination_logs).not.toContain("elimination_logs_p2024_12");
    expect(fake.partitions.elimination_logs).toContain("elimination_logs_p2026_12");
    expect(fake.archiveRelations.has("elimination_logs_p2024_12")).toBe(true);
    // default partitions are never archived
    expect(fake.partitions.elimination_logs).toContain("elimination_logs_p_default");
    expect(fake.partitions.transactions).toContain("transactions_p_default");
  });

  it("keeps partitions inside the retention window attached", async () => {
    const fake = fakePrisma({
      elimination_logs: ["elimination_logs_p2025_09", "elimination_logs_p2026_10", "elimination_logs_p_default"],
      transactions: ["transactions_p2026_10", "transactions_p_default"],
    });
    const ephemeral = fakeEphemeralStore();
    const worker = workerWith(fake, ephemeral);

    const result = await worker.run({ now: NOW });

    expect(result.status).toBe("success");
    // 2025-09 is exactly at the cutoff boundary (>= cutoff) → stays hot
    expect(result.archivedPartitions).toEqual([]);
    expect(fake.partitions.elimination_logs).toContain("elimination_logs_p2025_09");
  });

  it("reports a partition-creation failure as a warning but keeps going", async () => {
    const fake = fakePrisma(INITIAL);
    fake.failCreateFor(/^elimination_logs_p/);
    const ephemeral = fakeEphemeralStore();
    const worker = workerWith(fake, ephemeral);

    const result = await worker.run({ now: NOW });

    expect(result.status).toBe("success");
    expect(result.warnings.join("\n")).toMatch(/elimination_logs_p2026_11/);
    expect(result.createdPartitions.map((p) => p.table)).not.toContain("elimination_logs");
    // transactions create-ahead still succeeded
    expect(result.createdPartitions.map((p) => p.table)).toContain("transactions");
    // archival still ran
    expect(result.archivedPartitions.map((p) => p.name)).toContain("elimination_logs_p2024_12");
  });

  it("skips archiving when the archive schema already holds the partition name", async () => {
    const fake = fakePrisma(INITIAL);
    fake.archiveRelations.add("elimination_logs_p2024_12");
    const ephemeral = fakeEphemeralStore();
    const worker = workerWith(fake, ephemeral);

    const result = await worker.run({ now: NOW });

    expect(result.status).toBe("success");
    expect(result.warnings.join("\n")).toMatch(/already exists in the archive schema/);
    expect(result.archivedPartitions.map((p) => p.name)).not.toContain("elimination_logs_p2024_12");
    expect(fake.ddlExecuted.join("\n")).not.toContain("elimination_logs_p2024_12");
    // the transactions partition was still archived
    expect(result.archivedPartitions.map((p) => p.name)).toContain("transactions_p2025_01");
  });

  it("fails the run when ephemeral cleanup throws", async () => {
    const fake = fakePrisma(INITIAL);
    const failing: EphemeralRetentionStore = {
      countExpired: async () => {
        throw new Error("mongo down");
      },
      deleteExpired: async () => {
        throw new Error("mongo down");
      },
    };
    const worker = new RetentionWorker(fake.prisma as never, {
      config: CONFIG,
      ephemeralStore: failing,
    });

    const result = await worker.run({ now: NOW });

    expect(result.status).toBe("failed");
    expect(result.errors.join("\n")).toMatch(/ephemeral cleanup failed: Error: mongo down/);
  });

  it("skips a concurrent run while one is already in flight", async () => {
    const fake = fakePrisma(INITIAL);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowStore: EphemeralRetentionStore = {
      countExpired: async () => ({ nonces: 0, refreshTokens: 0, transactionIntents: 0 }),
      deleteExpired: async () => {
        await gate;
        return { nonces: 0, refreshTokens: 0, transactionIntents: 0 };
      },
    };
    const worker = new RetentionWorker(fake.prisma as never, {
      config: CONFIG,
      ephemeralStore: slowStore,
    });

    const first = worker.run({ now: NOW });
    const second = await worker.run({ now: NOW });

    expect(second.dryRun).toBe(false);
    expect(second.createdPartitions).toEqual([]);
    expect(second.archivedPartitions).toEqual([]);
    expect(second.durationMs).toBe(0);
    expect(second.ephemeralDeleted).toEqual({ nonces: 0, refreshTokens: 0, transactionIntents: 0 });

    release();
    const firstResult = await first;
    expect(firstResult.status).toBe("success");
  });

  it("refuses unsafe identifiers before they reach interpolated DDL", async () => {
    const fake = fakePrisma(INITIAL);
    const ephemeral = fakeEphemeralStore();
    const worker = workerWith(fake, ephemeral);

    await expect(worker.listPartitions('users; DROP TABLE users')).rejects.toThrow(
      /Refusing to use unsafe SQL identifier/,
    );
  });
});

describe("getRetentionConfig", () => {
  it("falls back to defaults when unset", () => {
    expect(getRetentionConfig({})).toEqual({
      partitionAheadMonths: 3,
      transactionsArchiveAfterMonths: 13,
      eliminationLogsArchiveAfterMonths: 13,
    });
  });

  it("parses declared overrides", () => {
    expect(
      getRetentionConfig({
        PARTITION_AHEAD_MONTHS: "6",
        RETENTION_TRANSACTIONS_ARCHIVE_AFTER_MONTHS: "24",
        RETENTION_ELIMINATION_LOGS_ARCHIVE_AFTER_MONTHS: "12",
      }),
    ).toEqual({
      partitionAheadMonths: 6,
      transactionsArchiveAfterMonths: 24,
      eliminationLogsArchiveAfterMonths: 12,
    });
  });

  it("rejects invalid values", () => {
    expect(() => getRetentionConfig({ PARTITION_AHEAD_MONTHS: "-1" })).toThrow(
      /PARTITION_AHEAD_MONTHS must be a non-negative integer/,
    );
    expect(() =>
      getRetentionConfig({ RETENTION_TRANSACTIONS_ARCHIVE_AFTER_MONTHS: "0" }),
    ).toThrow(/RETENTION_TRANSACTIONS_ARCHIVE_AFTER_MONTHS must be a positive integer/);
  });
});
