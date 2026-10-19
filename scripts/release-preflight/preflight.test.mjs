// Tests for the release preflight (#1465).
// Run: node --test scripts/release-preflight/preflight.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_REQUIRED_CONFIG_KEYS,
  checkAbiSnapshots,
  checkConfig,
  checkMigrations,
  checkRollback,
  detectDestructiveStatements,
  parseEnvExample,
  summarize,
} from "./policy.mjs";
import { collectArtifacts, parseArgs, runPreflight } from "./preflight.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "preflight.mjs");

function migration(name, { sql = "CREATE TABLE t (id int);", rollback = false } = {}) {
  return { name, hasSql: true, sql, hasRollback: rollback };
}

// ---- destructive statement detection -----------------------------------------------

test("detects destructive statements, ignoring commented-out ones", () => {
  assert.deepEqual(
    detectDestructiveStatements("DROP TABLE users;").map((d) => d.kind),
    ["drop_table"],
  );
  assert.deepEqual(
    detectDestructiveStatements("-- DROP TABLE users;\nALTER TABLE a ADD COLUMN b int;"),
    [],
  );
  // Case-insensitive and whitespace-tolerant.
  assert.deepEqual(
    detectDestructiveStatements("drop   column legacy").map((d) => d.kind),
    ["drop_column"],
  );
  assert.deepEqual(detectDestructiveStatements(null), []);
});

// ---- migrations --------------------------------------------------------------------

test("a clean migration set passes", () => {
  const findings = checkMigrations({
    migrations: [migration("20260101000000_init")],
    provider: "postgresql",
  });
  assert.equal(summarize(findings).pass, true);
});

test("provider mismatch, missing sql, and duplicate names are errors", () => {
  const result = summarize(
    checkMigrations({
      migrations: [
        { name: "a", hasSql: false, sql: null, hasRollback: false },
        migration("a"),
      ],
      provider: "sqlite",
    }),
  );
  const codes = result.findings.map((f) => f.code);
  assert.equal(result.pass, false);
  assert.ok(codes.includes("migration_provider_mismatch"));
  assert.ok(codes.includes("migration_missing_sql"));
  assert.ok(codes.includes("duplicate_migration"));
});

test("no migrations at all fails closed", () => {
  assert.equal(summarize(checkMigrations({ migrations: [], provider: "postgresql" })).pass, false);
});

test("a destructive migration without a rollback is an error, with one it is a warning", () => {
  const without = summarize(
    checkMigrations({ migrations: [migration("m1", { sql: "DROP TABLE t;" })], provider: "postgresql" }),
  );
  assert.equal(without.pass, false);
  assert.equal(without.findings[0].code, "destructive_drop_table");

  const withRollback = summarize(
    checkMigrations({
      migrations: [migration("m1", { sql: "DROP TABLE t;", rollback: true })],
      provider: "postgresql",
    }),
  );
  assert.equal(withRollback.pass, true);
  assert.equal(withRollback.warningCount, 1);
});

test("an allowlisted destructive statement is not flagged", () => {
  const result = summarize(
    checkMigrations({
      migrations: [migration("m1", { sql: "DROP TABLE t;" })],
      provider: "postgresql",
      allowlist: ["m1:drop_table"],
    }),
  );
  assert.equal(result.pass, true);
  assert.equal(result.findings.length, 0);
});

// ---- ABIs --------------------------------------------------------------------------

test("missing or invalid ABI snapshots and unreadable versions are errors", () => {
  const result = summarize(
    checkAbiSnapshots({
      contracts: [
        { name: "arena", hasSnapshot: true, isJsonArray: true, contractVersion: 3 },
        { name: "factory", hasSnapshot: false, isJsonArray: false, contractVersion: 2 },
        { name: "payout", hasSnapshot: true, isJsonArray: false, contractVersion: 1 },
        { name: "staking", hasSnapshot: true, isJsonArray: true, contractVersion: null },
      ],
    }),
  );
  assert.equal(result.pass, false);
  assert.deepEqual(result.findings.map((f) => f.code).sort(), [
    "abi_snapshot_invalid",
    "abi_snapshot_missing",
    "contract_version_unreadable",
  ]);
});

// ---- config ------------------------------------------------------------------------

test("parseEnvExample ignores comments and blank lines", () => {
  const { keys } = parseEnvExample("# a comment\nFOO=1\n\n# BAR=2\nBAZ=3\n");
  assert.ok(keys.has("FOO"));
  assert.ok(keys.has("BAZ"));
  assert.ok(!keys.has("BAR"));
});

test("a missing required key fails in every environment", () => {
  const findings = checkConfig({
    envExampleText: "DATABASE_URL=postgres://x\n",
    environment: "staging",
  });
  assert.equal(summarize(findings).pass, false);
  assert.ok(findings.some((f) => f.artifact === "backend/.env.example" && f.code === "required_config_missing"));
});

test("a placeholder secret fails only in production, and only against the real environment", () => {
  const env = DEFAULT_REQUIRED_CONFIG_KEYS.map((k) => `${k}=real`).join("\n");
  const realEnv = {
    JWT_SECRET: "change-me-minimum-32-characters-long",
    ADMIN_API_KEY: "change-me-in-production",
  };

  // `.env.example` shipping placeholders is expected — never a finding.
  const exampleOnly = summarize(checkConfig({ envExampleText: env, environment: "production" }));
  assert.equal(exampleOnly.pass, true);

  const dev = summarize(checkConfig({ envExampleText: env, envValues: realEnv, environment: "development" }));
  assert.equal(dev.pass, true);

  const prod = summarize(checkConfig({ envExampleText: env, envValues: realEnv, environment: "production" }));
  assert.equal(prod.pass, false);
  assert.equal(prod.findings.filter((f) => f.code === "placeholder_secret_in_production").length, 2);
});

test("a fully-populated production config passes", () => {
  const env = DEFAULT_REQUIRED_CONFIG_KEYS.map((k) => `${k}=real`).join("\n");
  const realEnv = Object.fromEntries(DEFAULT_REQUIRED_CONFIG_KEYS.map((k) => [k, "real"]));
  assert.equal(summarize(checkConfig({ envExampleText: env, envValues: realEnv, environment: "production" })).pass, true);
});

// ---- rollback ----------------------------------------------------------------------

test("a missing rollback section is an error", () => {
  const result = summarize(checkRollback({ migrations: [], rollbackDoc: "# Deployment\n" }));
  assert.equal(result.pass, false);
  assert.equal(result.findings[0].code, "rollback_doc_missing");
});

test("an undocumented migration is a warning, a documented one is silent", () => {
  const doc = "## Rollback\n\nRoll back `m1` by restoring the prior image.\n";
  const result = summarize(checkRollback({ migrations: [migration("m1"), migration("m2")], rollbackDoc: doc }));
  assert.equal(result.pass, true);
  assert.deepEqual(result.findings.map((f) => f.artifact), ["m2"]);
});

test("a migration with its own rollback.sql needs no doc reference", () => {
  const result = summarize(
    checkRollback({ migrations: [migration("m1", { rollback: true })], rollbackDoc: "## Rollback\n" }),
  );
  assert.equal(result.findings.length, 0);
});

// ---- end-to-end (cross-module) -----------------------------------------------------

function fixtureRepo({ provider = "postgresql", destructive = false, snapshot = true, env = "real", doc = "## Rollback\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "preflight-"));
  const migrations = join(root, "backend", "prisma", "migrations");
  const mig = join(migrations, "20260101000000_init");
  mkdirSync(mig, { recursive: true });
  writeFileSync(join(migrations, "migration_lock.toml"), `provider = "${provider}"\n`);
  writeFileSync(join(mig, "migration.sql"), destructive ? "DROP TABLE t;\n" : "CREATE TABLE t (id int);\n");
  if (destructive) writeFileSync(join(mig, "rollback.sql"), "CREATE TABLE t (id int);\n");
  writeFileSync(join(root, "backend", ".env.example"), DEFAULT_REQUIRED_CONFIG_KEYS.map((k) => `${k}=${env}`).join("\n"));
  writeFileSync(join(root, "DEPLOYMENT.md"), doc);
  for (const name of ["arena", "factory", "payout", "staking"]) {
    const dir = join(root, "contract", name, "src");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, "contract", name, "src", "lib.rs"), "const CONTRACT_VERSION: u32 = 1;\n");
    if (snapshot) writeFileSync(join(root, "contract", name, "abi_snapshot.json"), '["AAAA"]');
  }
  return root;
}

test("collectArtifacts + runPreflight pass a compatible repository", () => {
  const root = fixtureRepo();
  const artifacts = collectArtifacts(root);
  assert.equal(artifacts.migrationProvider, "postgresql");
  assert.equal(artifacts.migrations.length, 1);
  assert.equal(artifacts.contracts.length, 4);

  const result = runPreflight(["--root", root], {}, collectArtifacts);
  assert.equal(result.pass, true);
  assert.equal(result.errorCount, 0);
});

test("runPreflight blocks on a destructive migration with no rollback plan", () => {
  const root = fixtureRepo({ destructive: true, doc: "# Deployment\n" });
  const result = runPreflight(["--root", root], {}, collectArtifacts);
  assert.equal(result.pass, false);
  assert.ok(result.findings.some((f) => f.check === "rollback" && f.level === "error"));
});

test("runPreflight blocks a production deploy carrying placeholder secrets", () => {
  const root = fixtureRepo({ env: "real", snapshot: true });
  const placeholderEnv = { ADMIN_API_KEY: "change-me-in-production" };
  const blocked = runPreflight(
    ["--root", root, "--environment", "production"],
    placeholderEnv,
    collectArtifacts,
  );
  assert.equal(blocked.pass, false);
  assert.ok(blocked.findings.some((f) => f.code === "placeholder_secret_in_production"));
  // A non-production environment tolerates the same placeholder.
  const allowed = runPreflight(["--root", root, "--environment", "staging"], placeholderEnv, collectArtifacts);
  assert.equal(allowed.pass, true);
});

test("re-running the preflight after fixing the tree flips the result (retry is idempotent)", () => {
  const root = fixtureRepo({ snapshot: false });
  assert.equal(runPreflight(["--root", root], {}, collectArtifacts).pass, false);
  // Fix the missing artifact, then retry: same invocation, now green.
  for (const name of ["arena", "factory", "payout", "staking"]) {
    writeFileSync(join(root, "contract", name, "abi_snapshot.json"), '["AAAA"]');
  }
  const retry = runPreflight(["--root", root], {}, collectArtifacts);
  assert.equal(retry.pass, true);
  // Deterministic: a second identical run yields the same summary.
  const again = runPreflight(["--root", root], {}, collectArtifacts);
  assert.deepEqual(again.findings, retry.findings);
});

// ---- CLI / argument handling -------------------------------------------------------

test("parseArgs rejects an unknown flag and an unknown environment", () => {
  assert.throws(() => parseArgs(["--nope", "x"]), /unknown flag/);
  assert.throws(() => parseArgs(["--environment", "prod"]), /--environment must be/);
});

test("CLI exit codes: 0 pass, 1 blocked, 2 usage error", () => {
  const good = spawnSync("node", [cli, "--root", fixtureRepo()], { encoding: "utf8" });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /"event":"release_preflight_result"/);

  const bad = spawnSync("node", [cli, "--root", fixtureRepo({ destructive: true, doc: "# x" })], {
    encoding: "utf8",
  });
  assert.equal(bad.status, 1);

  const usage = spawnSync("node", [cli, "--nope", "x"], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /release-preflight/);
});
