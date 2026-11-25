#!/usr/bin/env tsx
/**
 * scripts/release-preflight.ts
 *
 * Unified release preflight command covering Prisma migrations, Soroban contract
 * ABIs & deployment manifests, environment/network config, and rollback readiness (#1465).
 *
 * Usage:
 *   pnpm exec tsx scripts/release-preflight.ts --dry-run --network testnet
 *   make release-preflight DRY_RUN=1 NETWORK=testnet
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NETWORK_PASSPHRASES,
  validateManifest,
  type ContractDeploymentManifest,
} from "./contract-manifest";
// @ts-ignore — ESM JS helper in contract/scripts
import { checkAbiSnapshots } from "../contract/scripts/check-abi-compatibility.mjs";

export type ReleaseNetwork = "testnet" | "mainnet" | "standalone";
export type PreflightCategory = "migrations" | "abis" | "config" | "rollback";
export type PreflightStatus = "pass" | "fail" | "skip";
export type OutputFormat = "json" | "text";

export interface PreflightCheckResult {
  name: string;
  category: PreflightCategory;
  status: PreflightStatus;
  durationMs: number;
  attempts: number;
  retries: number;
  errors: string[];
  warnings: string[];
  metadata?: Record<string, unknown>;
}

export interface PreflightReport {
  schemaVersion: 1;
  status: "pass" | "fail";
  dryRun: boolean;
  network: ReleaseNetwork;
  timestamp: string;
  durationMs: number;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    warnings: number;
  };
  checks: PreflightCheckResult[];
}

export interface PreflightOptions {
  rootDir: string;
  network: ReleaseNetwork;
  dryRun: boolean;
  format: OutputFormat;
  maxRetries: number;
  retryDelayMs: number;
  requireWasm: boolean;
  skipLiveDb: boolean;
  allowDestructiveMigrations: boolean;
  manifestPath?: string;
  env: NodeJS.ProcessEnv;
}

export interface CheckOutcome {
  status: PreflightStatus;
  errors: string[];
  warnings: string[];
  metadata?: Record<string, unknown>;
}

export interface PreflightRunnerDeps {
  execCommand?: (cmd: string, args: string[], cwd: string) => string;
  log?: (entry: Record<string, unknown>) => void;
}

const MAX_MIGRATION_BYTES = 5 * 1024 * 1024; // 5 MiB guard per migration file
const DESTRUCTIVE_DDL_PATTERN = /\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE\s+TABLE)\b/i;
const ROLLBACK_COMMENT_PATTERN = /--\s*(rollback|reversible)\s*:/i;
const HISTORICAL_DESTRUCTIVE_MIGRATIONS = new Set([
  "20261020000000_partition_high_volume_tables",
]);

function defaultExec(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function defaultLog(entry: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function executeWithRetry(
  name: string,
  category: PreflightCategory,
  maxRetries: number,
  retryDelayMs: number,
  fn: () => Promise<CheckOutcome> | CheckOutcome,
  log: (entry: Record<string, unknown>) => void = defaultLog,
): Promise<PreflightCheckResult> {
  const started = Date.now();
  let attempts = 0;
  let lastError: unknown;

  while (attempts <= maxRetries) {
    attempts += 1;
    try {
      const outcome = await fn();
      const durationMs = Date.now() - started;
      const retries = attempts - 1;
      log({
        event: "preflight_check_complete",
        check: name,
        category,
        status: outcome.status,
        attempts,
        retries,
        durationMs,
      });
      return {
        name,
        category,
        status: outcome.status,
        durationMs,
        attempts,
        retries,
        errors: outcome.errors,
        warnings: outcome.warnings,
        metadata: outcome.metadata,
      };
    } catch (error) {
      lastError = error;
      if (attempts <= maxRetries) {
        log({
          event: "preflight_check_retry",
          check: name,
          category,
          attempt: attempts,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(retryDelayMs * attempts);
      }
    }
  }

  const durationMs = Date.now() - started;
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  log({
    event: "preflight_check_complete",
    check: name,
    category,
    status: "fail",
    attempts,
    retries: attempts - 1,
    durationMs,
    error: message,
  });
  return {
    name,
    category,
    status: "fail",
    durationMs,
    attempts,
    retries: attempts - 1,
    errors: [message],
    warnings: [],
  };
}

export function checkMigrations(
  options: PreflightOptions,
  deps: PreflightRunnerDeps = {},
): CheckOutcome {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prismaDir = join(options.rootDir, "backend/prisma");
  const schemaPath = join(prismaDir, "schema.prisma");
  const migrationsDir = join(prismaDir, "migrations");
  const lockPath = join(migrationsDir, "migration_lock.toml");

  if (!existsSync(schemaPath)) {
    errors.push("Missing backend/prisma/schema.prisma");
  }
  if (!existsSync(lockPath)) {
    errors.push("Missing backend/prisma/migrations/migration_lock.toml");
  } else {
    const lockText = readFileSync(lockPath, "utf8");
    if (!/provider\s*=\s*"postgresql"/.test(lockText)) {
      errors.push('migration_lock.toml provider must be "postgresql"');
    }
  }

  let migrationCount = 0;
  if (!existsSync(migrationsDir)) {
    errors.push("Missing backend/prisma/migrations directory");
  } else {
    const entries = readdirSync(migrationsDir, { withFileTypes: true }).filter((d) =>
      d.isDirectory(),
    );
    migrationCount = entries.length;
    for (const dir of entries) {
      if (HISTORICAL_DESTRUCTIVE_MIGRATIONS.has(dir.name)) continue;
      const sqlPath = join(migrationsDir, dir.name, "migration.sql");
      if (!existsSync(sqlPath)) {
        errors.push(`Migration ${dir.name} is missing migration.sql`);
        continue;
      }
      const stat = statSync(sqlPath);
      if (stat.size === 0) {
        errors.push(`Migration ${dir.name}/migration.sql is empty`);
      } else if (stat.size > MAX_MIGRATION_BYTES) {
        errors.push(`Migration ${dir.name}/migration.sql exceeds ${MAX_MIGRATION_BYTES} bytes`);
      }
    }
  }

  if (errors.length === 0 && !options.skipLiveDb && options.env.DATABASE_URL) {
    const execFn = deps.execCommand ?? defaultExec;
    execFn("pnpm", ["exec", "prisma", "migrate", "status"], join(options.rootDir, "backend"));
  } else if (!options.env.DATABASE_URL || options.skipLiveDb) {
    warnings.push("DATABASE_URL not set or --skip-live-db specified; skipped live prisma migrate status");
  }

  return {
    status: errors.length === 0 ? "pass" : "fail",
    errors,
    warnings,
    metadata: { migrationCount },
  };
}

export function checkAbis(options: PreflightOptions): CheckOutcome {
  const errors: string[] = [];
  const warnings: string[] = [];
  const contractDir = join(options.rootDir, "contract");

  const abiResult = checkAbiSnapshots({
    contractDir,
    requireWasm: options.requireWasm,
  });
  errors.push(...abiResult.errors);
  warnings.push(...abiResult.warnings);

  const manifestFile =
    options.manifestPath ?? join(contractDir, "deployment-manifest.json");
  if (!existsSync(manifestFile)) {
    errors.push(`Missing contract deployment manifest: ${manifestFile}`);
    return { status: "fail", errors, warnings };
  }

  let parsedManifest: ContractDeploymentManifest | undefined;
  try {
    const raw = JSON.parse(readFileSync(manifestFile, "utf8")) as ContractDeploymentManifest;
    const validation = validateManifest(raw);
    errors.push(...validation.errors);
    warnings.push(...validation.warnings);
    parsedManifest = raw;
  } catch (err) {
    errors.push(
      `Malformed deployment manifest JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (parsedManifest && parsedManifest.network !== options.network) {
    errors.push(
      `network_mismatch: manifest network "${parsedManifest.network}" does not match target "${options.network}"`,
    );
  }

  return {
    status: errors.length === 0 ? "pass" : "fail",
    errors,
    warnings,
    metadata: {
      checkedAbis: abiResult.checked.length,
      manifestNetwork: parsedManifest?.network,
    },
  };
}

export function checkConfig(
  options: PreflightOptions,
  deps: PreflightRunnerDeps = {},
): CheckOutcome {
  const errors: string[] = [];
  const warnings: string[] = [];
  const execFn = deps.execCommand ?? defaultExec;

  try {
    execFn(
      "pnpm",
      ["exec", "tsx", "../scripts/env-example.ts", "backend", "--check"],
      join(options.rootDir, "backend"),
    );
  } catch (err) {
    errors.push(
      `backend/.env.example is out of sync with env schema: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const expectedPassphrase = NETWORK_PASSPHRASES[options.network];
  const configuredPassphrase = options.env.STELLAR_NETWORK_PASSPHRASE?.trim();
  if (configuredPassphrase && configuredPassphrase !== expectedPassphrase) {
    errors.push(
      `network_mismatch: STELLAR_NETWORK_PASSPHRASE "${configuredPassphrase}" does not match ${options.network} ("${expectedPassphrase}")`,
    );
  }

  const frontendPassphrase = options.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE?.trim();
  if (frontendPassphrase && frontendPassphrase !== expectedPassphrase) {
    errors.push(
      `network_mismatch: NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE "${frontendPassphrase}" does not match ${options.network}`,
    );
  }

  if (!configuredPassphrase) {
    warnings.push("STELLAR_NETWORK_PASSPHRASE not set in environment; skipped live passphrase match");
  }

  return {
    status: errors.length === 0 ? "pass" : "fail",
    errors,
    warnings,
    metadata: { targetNetwork: options.network, expectedPassphrase },
  };
}

export function checkRollback(options: PreflightOptions): CheckOutcome {
  const errors: string[] = [];
  const warnings: string[] = [];
  const migrationsDir = join(options.rootDir, "backend/prisma/migrations");

  if (existsSync(migrationsDir)) {
    const entries = readdirSync(migrationsDir, { withFileTypes: true }).filter((d) =>
      d.isDirectory(),
    );
    for (const dir of entries) {
      if (HISTORICAL_DESTRUCTIVE_MIGRATIONS.has(dir.name)) continue;
      const sqlPath = join(migrationsDir, dir.name, "migration.sql");
      if (!existsSync(sqlPath)) continue;
      const sql = readFileSync(sqlPath, "utf8");
      if (
        DESTRUCTIVE_DDL_PATTERN.test(sql) &&
        !ROLLBACK_COMMENT_PATTERN.test(sql) &&
        !options.allowDestructiveMigrations
      ) {
        errors.push(
          `Destructive DDL in migration ${dir.name}/migration.sql without '-- rollback:' note (or pass --allow-destructive-migrations)`,
        );
      }
    }
  }

  const manifestFile =
    options.manifestPath ?? join(options.rootDir, "contract/deployment-manifest.json");
  if (!existsSync(manifestFile)) {
    errors.push("Cannot verify contract rollback metadata: deployment-manifest.json missing");
  } else {
    try {
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Partial<ContractDeploymentManifest>;
      if (manifest.schemaVersion !== 1) {
        errors.push(`Unsupported manifest schemaVersion for rollback: ${manifest.schemaVersion}`);
      }
    } catch {
      errors.push("Cannot parse deployment-manifest.json for rollback metadata");
    }
  }

  const deploymentDoc = join(options.rootDir, "DEPLOYMENT.md");
  if (!existsSync(deploymentDoc) || !readFileSync(deploymentDoc, "utf8").includes("## Client compatibility manifest")) {
    warnings.push("DEPLOYMENT.md is missing the Client compatibility manifest rollback section");
  }

  return {
    status: errors.length === 0 ? "pass" : "fail",
    errors,
    warnings,
  };
}

export async function runReleasePreflight(
  options: PreflightOptions,
  deps: PreflightRunnerDeps = {},
): Promise<PreflightReport> {
  const started = Date.now();
  const log = deps.log ?? defaultLog;

  const checks = await Promise.all([
    executeWithRetry("prisma.migrations", "migrations", options.maxRetries, options.retryDelayMs, () => checkMigrations(options, deps), log),
    executeWithRetry("soroban.abis_and_manifest", "abis", options.maxRetries, options.retryDelayMs, () => checkAbis(options), log),
    executeWithRetry("env.config_and_network", "config", options.maxRetries, options.retryDelayMs, () => checkConfig(options, deps), log),
    executeWithRetry("release.rollback_readiness", "rollback", options.maxRetries, options.retryDelayMs, () => checkRollback(options), log),
  ]);

  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const skipped = checks.filter((c) => c.status === "skip").length;
  const warnings = checks.reduce((sum, c) => sum + c.warnings.length, 0);
  const status: "pass" | "fail" = failed > 0 ? "fail" : "pass";
  const durationMs = Date.now() - started;

  log({
    event: "preflight_complete",
    status,
    dryRun: options.dryRun,
    network: options.network,
    durationMs,
    passed,
    failed,
  });

  return {
    schemaVersion: 1,
    status,
    dryRun: options.dryRun,
    network: options.network,
    timestamp: new Date().toISOString(),
    durationMs,
    summary: {
      total: checks.length,
      passed,
      failed,
      skipped,
      warnings,
    },
    checks,
  };
}

export function parseCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): PreflightOptions {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let network: ReleaseNetwork = "testnet";
  let dryRun = false;
  let format: OutputFormat | undefined;
  let maxRetries = 1;
  let retryDelayMs = 200;
  let requireWasm = false;
  let skipLiveDb = false;
  let allowDestructiveMigrations = false;
  let manifestPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--require-wasm") requireWasm = true;
    else if (arg === "--skip-live-db") skipLiveDb = true;
    else if (arg === "--allow-destructive-migrations") allowDestructiveMigrations = true;
    else if (arg === "--network" && argv[i + 1]) {
      const val = argv[++i]!;
      if (val !== "testnet" && val !== "mainnet" && val !== "standalone") {
        throw new Error(`Invalid --network value: ${val}`);
      }
      network = val;
    } else if (arg === "--format" && argv[i + 1]) {
      const val = argv[++i]!;
      if (val !== "json" && val !== "text") {
        throw new Error(`Invalid --format value: ${val}`);
      }
      format = val;
    } else if (arg === "--max-retries" && argv[i + 1]) {
      const n = Number(argv[++i]!);
      if (!Number.isInteger(n) || n < 0 || n > 10) {
        throw new Error(`Invalid --max-retries value: ${n}`);
      }
      maxRetries = n;
    } else if (arg === "--manifest" && argv[i + 1]) {
      manifestPath = resolve(argv[++i]!);
    }
  }

  return {
    rootDir: repoRoot,
    network,
    dryRun,
    format: format ?? (dryRun ? "json" : "text"),
    maxRetries,
    retryDelayMs,
    requireWasm,
    skipLiveDb: skipLiveDb || dryRun,
    allowDestructiveMigrations,
    manifestPath,
    env,
  };
}

function formatTextReport(report: PreflightReport): string {
  const lines = [
    `Release Preflight (${report.network}, dryRun=${report.dryRun}): ${report.status.toUpperCase()} (${report.durationMs}ms)`,
  ];
  for (const check of report.checks) {
    lines.push(
      `  [${check.status.toUpperCase()}] ${check.name} (${check.category}, ${check.durationMs}ms, attempts=${check.attempts})`,
    );
    for (const err of check.errors) lines.push(`    ERROR: ${err}`);
    for (const warn of check.warnings) lines.push(`    WARN: ${warn}`);
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseCliArgs(process.argv.slice(2));
  runReleasePreflight(options)
    .then((report) => {
      if (options.format === "json") {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(formatTextReport(report));
      }
      if (report.status === "fail") process.exitCode = 1;
    })
    .catch((err) => {
      process.stderr.write(
        `${JSON.stringify({ event: "preflight_fatal", error: err instanceof Error ? err.message : String(err) })}\n`,
      );
      process.exitCode = 1;
    });
}
