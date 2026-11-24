import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkAbis,
  checkConfig,
  checkMigrations,
  checkRollback,
  executeWithRetry,
  parseCliArgs,
  runReleasePreflight,
  type PreflightOptions,
} from "./release-preflight";
import { NETWORK_PASSPHRASES } from "./contract-manifest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VALID_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const VALID_WASM_HASH = "a".repeat(64);

function createFixtureWorkspace(network: "testnet" | "mainnet" | "standalone" = "testnet"): string {
  const dir = mkdtempSync(join(tmpdir(), "preflight-test-"));

  // Prisma fixture
  const migDir = join(dir, "backend/prisma/migrations/20260101000000_init");
  mkdirSync(migDir, { recursive: true });
  writeFileSync(join(dir, "backend/prisma/schema.prisma"), "datasource db { provider = \"postgresql\" }\n");
  writeFileSync(join(dir, "backend/prisma/migrations/migration_lock.toml"), 'provider = "postgresql"\n');
  writeFileSync(join(migDir, "migration.sql"), "CREATE TABLE test_tbl (id TEXT PRIMARY KEY);\n");

  // Contract ABI + manifest fixture
  for (const name of ["arena", "factory", "payout", "staking"]) {
    mkdirSync(join(dir, "contract", name), { recursive: true });
    writeFileSync(join(dir, "contract", name, "abi_snapshot.json"), JSON.stringify([{ name: "version" }]));
  }

  writeFileSync(
    join(dir, "contract/deployment-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      network,
      networkPassphrase: NETWORK_PASSPHRASES[network],
      rpcUrl: "https://soroban-testnet.stellar.org",
      deployedAt: "2026-01-01T00:00:00Z",
      contracts: {
        arena: { id: VALID_CONTRACT_ID, wasmHash: VALID_WASM_HASH, abiVersion: "1.0.0", methods: ["version"] },
        factory: { id: VALID_CONTRACT_ID, wasmHash: VALID_WASM_HASH, abiVersion: "1.0.0", methods: ["version"] },
        payout: { id: VALID_CONTRACT_ID, wasmHash: VALID_WASM_HASH, abiVersion: "1.0.0", methods: ["version"] },
        staking: { id: VALID_CONTRACT_ID, wasmHash: VALID_WASM_HASH, abiVersion: "1.0.0", methods: ["version"] },
      },
    }),
  );

  writeFileSync(join(dir, "DEPLOYMENT.md"), "# Deployment\n\n## Client compatibility manifest\n");
  return dir;
}

function makeOptions(rootDir: string, overrides: Partial<PreflightOptions> = {}): PreflightOptions {
  return {
    rootDir,
    network: "testnet",
    dryRun: true,
    format: "json",
    maxRetries: 1,
    retryDelayMs: 0,
    requireWasm: false,
    skipLiveDb: true,
    allowDestructiveMigrations: false,
    env: {},
    ...overrides,
  };
}

describe("release-preflight (#1465)", () => {
  it("passes all 4 domains for a valid release workspace", async () => {
    const dir = createFixtureWorkspace("testnet");
    try {
      const report = await runReleasePreflight(makeOptions(dir), {
        execCommand: () => "ok",
        log: () => {},
      });

      assert.equal(report.schemaVersion, 1);
      assert.equal(report.status, "pass");
      assert.equal(report.dryRun, true);
      assert.equal(report.summary.total, 4);
      assert.equal(report.summary.passed, 4);
      assert.equal(report.summary.failed, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries transient check failures and records attempts/retries", async () => {
    let calls = 0;
    const result = await executeWithRetry(
      "transient.check",
      "config",
      2,
      0,
      () => {
        calls += 1;
        if (calls < 2) throw new Error("transient ECONNRESET");
        return { status: "pass", errors: [], warnings: [] };
      },
      () => {},
    );

    assert.equal(result.status, "pass");
    assert.equal(result.attempts, 2);
    assert.equal(result.retries, 1);

    const exhausted = await executeWithRetry(
      "always.fails",
      "config",
      1,
      0,
      () => {
        throw new Error("persistent failure");
      },
      () => {},
    );
    assert.equal(exhausted.status, "fail");
    assert.equal(exhausted.attempts, 2);
    assert.equal(exhausted.retries, 1);
    assert.match(exhausted.errors[0]!, /persistent failure/);
  });

  it("fails on network mismatch between manifest, env passphrase, and target network", async () => {
    const dir = createFixtureWorkspace("mainnet");
    try {
      const opts = makeOptions(dir, {
        network: "testnet",
        env: { STELLAR_NETWORK_PASSPHRASE: NETWORK_PASSPHRASES.mainnet },
      });
      const report = await runReleasePreflight(opts, {
        execCommand: () => "ok",
        log: () => {},
      });

      assert.equal(report.status, "fail");
      const abiCheck = report.checks.find((c) => c.category === "abis")!;
      const cfgCheck = report.checks.find((c) => c.category === "config")!;
      assert.equal(abiCheck.status, "fail");
      assert.ok(abiCheck.errors.some((e) => e.includes("network_mismatch")));
      assert.equal(cfgCheck.status, "fail");
      assert.ok(cfgCheck.errors.some((e) => e.includes("network_mismatch")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails on malformed or missing ABI snapshot", () => {
    const dir = createFixtureWorkspace("testnet");
    try {
      writeFileSync(join(dir, "contract/arena/abi_snapshot.json"), "{not-valid-json");
      const outcome = checkAbis(makeOptions(dir));
      assert.equal(outcome.status, "fail");
      assert.ok(outcome.errors.some((e) => e.includes("Malformed JSON")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails on empty or oversized migration SQL and unguarded destructive DDL", () => {
    const dir = createFixtureWorkspace("testnet");
    try {
      const badMig = join(dir, "backend/prisma/migrations/20260201000000_drop_users");
      mkdirSync(badMig, { recursive: true });
      writeFileSync(join(badMig, "migration.sql"), "");

      const migOutcome = checkMigrations(makeOptions(dir));
      assert.equal(migOutcome.status, "fail");
      assert.ok(migOutcome.errors.some((e) => e.includes("is empty")));

      writeFileSync(join(badMig, "migration.sql"), "DROP TABLE users;\n");
      const rollbackFail = checkRollback(makeOptions(dir));
      assert.equal(rollbackFail.status, "fail");
      assert.ok(rollbackFail.errors.some((e) => e.includes("Destructive DDL")));

      writeFileSync(join(badMig, "migration.sql"), "-- rollback: restore from snapshot\nDROP TABLE users;\n");
      const rollbackPass = checkRollback(makeOptions(dir));
      assert.equal(rollbackPass.status, "pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid CLI arguments", () => {
    assert.throws(() => parseCliArgs(["--network", "invalid"]), /Invalid --network/);
    assert.throws(() => parseCliArgs(["--format", "xml"]), /Invalid --format/);
    assert.throws(() => parseCliArgs(["--max-retries", "99"]), /Invalid --max-retries/);
  });

  it("integration: dry-run CLI emits machine-readable JSON across real repo modules", () => {
    let stdout = "";
    try {
      stdout = execFileSync(
        join(REPO_ROOT, "backend/node_modules/.bin/tsx"),
        [join(REPO_ROOT, "scripts/release-preflight.ts"), "--dry-run", "--network", "testnet"],
        { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err: unknown) {
      // Exit code 1 is expected if any repo artifact is incompatible (e.g., invalid staking ID in deployment-manifest.json)
      stdout = (err as { stdout?: string }).stdout ?? "";
    }

    const report = JSON.parse(stdout) as {
      schemaVersion: number;
      dryRun: boolean;
      checks: Array<{ category: string; status: string }>;
    };
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.dryRun, true);
    assert.deepEqual(
      report.checks.map((c) => c.category),
      ["migrations", "abis", "config", "rollback"],
    );
  });
});
