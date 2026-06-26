import { spawnSync } from "child_process";
import path from "path";
import { prisma } from "../../src/db/prisma";

const PRISMA_ROOT = path.resolve(__dirname, "../../");

describe("Prisma migration compatibility", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      console.warn("DATABASE_URL not set — skipping migration compatibility tests");
    }
  });

  it("has no pending migrations (all migrations applied)", () => {
    if (!process.env.DATABASE_URL) return;

    const result = spawnSync(
      "npx",
      ["prisma", "migrate", "status"],
      { cwd: PRISMA_ROOT, encoding: "utf-8", env: { ...process.env } },
    );

    // migrate status exits 0 when all migrations are applied
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/following migration.*not yet applied/i);
  });

  it("all expected tables exist after migrations", async () => {
    if (!process.env.DATABASE_URL) return;

    type TableRow = { table_name: string };
    const rows = await prisma.$queryRaw<TableRow[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
    `;

    const tableNames = rows.map((r) => r.table_name);

    const required = [
      "users",
      "arenas",
      "pools",
      "rounds",
      "transactions",
      "elimination_logs",
      "audit_logs",
    ];

    for (const table of required) {
      expect(tableNames).toContain(table);
    }
  });

  it("key columns exist on the users table", async () => {
    if (!process.env.DATABASE_URL) return;

    type ColRow = { column_name: string };
    const cols = await prisma.$queryRaw<ColRow[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
    `;

    const colNames = cols.map((c) => c.column_name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("wallet_address");
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("updated_at");
  });

  it("key columns exist on the rounds table", async () => {
    if (!process.env.DATABASE_URL) return;

    type ColRow = { column_name: string };
    const cols = await prisma.$queryRaw<ColRow[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'rounds'
    `;

    const colNames = cols.map((c) => c.column_name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("arena_id");
    expect(colNames).toContain("round_number");
    expect(colNames).toContain("state");
    expect(colNames).toContain("metadata");
  });

  it("key columns exist on the elimination_logs table", async () => {
    if (!process.env.DATABASE_URL) return;

    type ColRow = { column_name: string };
    const cols = await prisma.$queryRaw<ColRow[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'elimination_logs'
    `;

    const colNames = cols.map((c) => c.column_name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("round_id");
    expect(colNames).toContain("user_id");
    expect(colNames).toContain("reason");
    expect(colNames).toContain("eliminated_at");
  });

  it("seed script creates expected seed data", async () => {
    if (!process.env.DATABASE_URL) return;

    const result = spawnSync(
      "npx",
      ["tsx", "prisma/seed.ts"],
      { cwd: PRISMA_ROOT, encoding: "utf-8", env: { ...process.env } },
    );

    expect(result.status).toBe(0);

    const userCount = await prisma.user.count();
    expect(userCount).toBeGreaterThan(0);
  });

  /*
   * Rollback notice:
   * Prisma does not support automatic migration rollbacks. Rolling back requires
   * either manually reversing the SQL in a new migration or restoring from a
   * database snapshot taken before the migration was applied.
   *
   * Before applying any migration that drops columns or tables, verify with:
   *   npx prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel prisma/schema.prisma
   */
});
