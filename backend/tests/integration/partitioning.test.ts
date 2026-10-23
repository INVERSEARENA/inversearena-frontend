/**
 * Integration tests for monthly partitioning of the high-volume tables and
 * partition pruning of the hot query shapes (#1622).
 *
 * Requires a real PostgreSQL (DATABASE_URL); every test no-ops without it,
 * matching tests/integration/migration.test.ts. CI's integration tier runs
 * `prisma migrate deploy` first, so the partitioning migration
 * (20261020000000_partition_high_volume_tables) is already applied.
 */
import { randomUUID } from "crypto";
import { prisma } from "../../src/db/prisma";

const hasDb = () => Boolean(process.env.DATABASE_URL);

const pad = (n: number) => String(n).padStart(2, "0");
const monthLiteral = (year: number, month: number) => `${year}-${pad(month)}-01 00:00:00`;

async function explain(sql: string): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(`EXPLAIN (FORMAT TEXT) ${sql}`);
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}

/** Every distinct monthly partition name a plan touches, sorted. */
function partitionsInPlan(plan: string): string[] {
  const matches = plan.match(/\b(?:elimination_logs|transactions)_p\d{4}_\d{2}\b/g) ?? [];
  return [...new Set(matches)].sort();
}

describe("partitioned high-volume tables (#1622)", () => {
  beforeAll(() => {
    if (!hasDb()) {
      console.warn("DATABASE_URL not set — skipping partitioning integration tests");
    }
  });

  it("elimination_logs and transactions are RANGE-partitioned parents", async () => {
    if (!hasDb()) return;

    type Row = { relname: string; relkind: string };
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT c.relname, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relname IN ('elimination_logs', 'transactions')`;

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relkind).toBe("p"); // partitioned table
    }
  });

  it("the cold archive schema exists", async () => {
    if (!hasDb()) return;

    type Row = { nspname: string };
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT nspname FROM pg_namespace WHERE nspname = 'archive'`;
    expect(rows).toHaveLength(1);
  });

  it("monthly partitions cover the current month and a default partition exists", async () => {
    if (!hasDb()) return;

    const now = new Date();
    const current = `${now.getUTCFullYear()}_${pad(now.getUTCMonth() + 1)}`;

    for (const table of ["elimination_logs", "transactions"]) {
      type Row = { relname: string };
      const rows = await prisma.$queryRaw<Row[]>`
        SELECT c.relname
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent
        JOIN pg_namespace n ON n.oid = p.relnamespace
        WHERE n.nspname = current_schema() AND p.relname = ${table}`;
      const names = rows.map((r) => r.relname);
      expect(names).toContain(`${table}_p${current}`);
      expect(names).toContain(`${table}_p_default`);
    }
  });

  it("keeps Prisma's unique tx-hash contract as (tx_hash, created_at)", async () => {
    if (!hasDb()) return;

    type Row = { indexname: string };
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'transactions'`;
    const names = rows.map((r) => r.indexname);
    expect(names).toContain("transactions_tx_hash_created_at_key");
  });

  it("retains foreign keys from the partitioned parents", async () => {
    if (!hasDb()) return;

    type Row = { conname: string };
    const eliminationFks = await prisma.$queryRaw<Row[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'elimination_logs'::regclass AND contype = 'f'`;
    expect(eliminationFks.map((r) => r.conname).sort()).toEqual([
      "elimination_logs_round_id_fkey",
      "elimination_logs_user_id_fkey",
    ]);

    const transactionFks = await prisma.$queryRaw<Row[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'transactions'::regclass AND contype = 'f'`;
    expect(transactionFks.map((r) => r.conname)).toEqual(["transactions_user_id_fkey"]);
  });

  it("Prisma writes land in the current-month partition", async () => {
    if (!hasDb()) return;

    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: { walletAddress: `G-partition-test-${suffix}` },
    });
    const arena = await prisma.arena.create({ data: {} });
    const round = await prisma.round.create({
      data: { arenaId: arena.id, roundNumber: 1 },
    });
    const log = await prisma.eliminationLog.create({
      data: { roundId: round.id, userId: user.id, reason: "partition-test" },
    });
    const tx = await prisma.transaction.create({
      data: {
        txHash: `partition-test-${suffix}`,
        userId: user.id,
        amount: 1,
        type: "DEPOSIT",
        status: "SUCCESS",
      },
    });

    try {
      type PartitionRow = { partition: string };
      const [logPartition] = await prisma.$queryRawUnsafe<PartitionRow[]>(
        "SELECT tableoid::regclass::text AS partition FROM elimination_logs WHERE id = $1",
        log.id,
      );
      const [txPartition] = await prisma.$queryRawUnsafe<PartitionRow[]>(
        "SELECT tableoid::regclass::text AS partition FROM transactions WHERE id = $1 AND created_at = $2",
        tx.id,
        tx.createdAt,
      );

      const now = new Date();
      const current = `${now.getUTCFullYear()}_${pad(now.getUTCMonth() + 1)}`;
      expect(logPartition?.partition).toBe(`elimination_logs_p${current}`);
      expect(txPartition?.partition).toBe(`transactions_p${current}`);
    } finally {
      await prisma.$transaction([
        prisma.eliminationLog.delete({
          where: { id_eliminatedAt: { id: log.id, eliminatedAt: log.eliminatedAt } },
        }),
        prisma.transaction.delete({
          where: { id_createdAt: { id: tx.id, createdAt: tx.createdAt } },
        }),
        prisma.round.delete({ where: { id: round.id } }),
        prisma.arena.delete({ where: { id: arena.id } }),
        prisma.user.delete({ where: { id: user.id } }),
      ]);
    }
  });

  it("prunes a month-bounded elimination_logs query to a single partition", async () => {
    if (!hasDb()) return;

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;

    const plan = await explain(
      `SELECT el.id FROM elimination_logs el ` +
        `WHERE el.eliminated_at >= '${monthLiteral(year, month)}' ` +
        `AND el.eliminated_at < '${monthLiteral(nextYear, nextMonth)}'`,
    );

    expect(partitionsInPlan(plan)).toEqual([
      `elimination_logs_p${year}_${pad(month)}`,
    ]);
    expect(plan).not.toMatch(/elimination_logs_p_default/);
  });

  it("prunes a month-bounded transactions query to a single partition", async () => {
    if (!hasDb()) return;

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;

    const plan = await explain(
      `SELECT t.id FROM transactions t ` +
        `WHERE t.created_at >= '${monthLiteral(year, month)}' ` +
        `AND t.created_at < '${monthLiteral(nextYear, nextMonth)}'`,
    );

    expect(partitionsInPlan(plan)).toEqual([`transactions_p${year}_${pad(month)}`]);
    expect(plan).not.toMatch(/transactions_p_default/);
  });

  it("still plans the hot keyset-pagination shape on elimination_logs", async () => {
    if (!hasDb()) return;

    // Mirrors the pools route's keyset query shape (#1520): upper-bound-only
    // predicates cannot prune to one partition, but the plan must stay valid
    // and scan the partitioned parent's monthly children.
    const cursor = `${monthLiteral(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1)}`;
    const plan = await explain(
      `SELECT el.id, el.eliminated_at ` +
        `FROM elimination_logs el ` +
        `JOIN rounds r ON r.id = el.round_id ` +
        `WHERE r.arena_id = '00000000-0000-0000-0000-000000000000' ` +
        `AND (el.eliminated_at, el.id) < ('${cursor}', 'ffffffff-ffff-ffff-ffff-ffffffffffff') ` +
        `ORDER BY el.eliminated_at DESC, el.id DESC ` +
        `LIMIT 26`,
    );

    expect(plan).toMatch(/elimination_logs/);
    expect(partitionsInPlan(plan).length).toBeGreaterThanOrEqual(1);
  });

  it("still plans the queue-lag probe on transactions", async () => {
    if (!hasDb()) return;

    const plan = await explain(
      `SELECT t.created_at FROM transactions t WHERE t.status = 'PENDING' ORDER BY t.created_at ASC LIMIT 1`,
    );

    expect(plan).toMatch(/transactions/);
  });
});
