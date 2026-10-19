#!/usr/bin/env node
// Release preflight CLI (#1465).
//
//   node scripts/release-preflight/preflight.mjs \
//     [--root .] [--environment production] [--json] [--out preflight.json] \
//     [--allow 20260101000000_drop_legacy:drop_table] [--dry-run]
//
// The preflight is read-only: it never applies a migration, writes a snapshot,
// or contacts a network. `--dry-run` is accepted and is the only mode — it
// exists so a caller can be explicit and so the flag can be reserved for a
// future write mode without changing the interface.
//
// Exit codes: 0 pass, 1 blocked (an incompatible release artifact), 2 usage or
// I/O error. The final line of stdout is always a machine-readable JSON result
// so CI can parse it without scraping prose.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  checkAbiSnapshots,
  checkConfig,
  checkMigrations,
  checkRollback,
  summarize,
} from "./policy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(here, "..", "..");

const CONTRACT_NAMES = ["arena", "factory", "payout", "staking"];

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

export function parseArgs(argv) {
  const args = { root: DEFAULT_ROOT, environment: "production", out: null, allow: [], dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    i += 1;
    if (flag === "--root") args.root = resolve(value);
    else if (flag === "--environment") args.environment = value;
    else if (flag === "--out") args.out = value;
    else if (flag === "--allow") args.allow.push(value);
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!["development", "staging", "production"].includes(args.environment)) {
    throw new Error(`--environment must be development|staging|production, got ${args.environment}`);
  }
  return args;
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function readJsonArray(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

function readMigrationProvider(root) {
  const lock = readText(join(root, "backend", "prisma", "migrations", "migration_lock.toml"));
  if (lock === null) return null;
  const match = /provider\s*=\s*"([^"]+)"/.exec(lock);
  return match ? match[1] : null;
}

function readMigrations(root) {
  const dir = join(root, "backend", "prisma", "migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory();
    })
    .sort()
    .map((name) => {
      const full = join(dir, name);
      const sqlPath = join(full, "migration.sql");
      return {
        name,
        hasSql: existsSync(sqlPath),
        sql: readText(sqlPath),
        hasRollback: existsSync(join(full, "rollback.sql")),
      };
    });
}

function readContracts(root) {
  return CONTRACT_NAMES.map((name) => {
    const dir = join(root, "contract", name);
    if (!existsSync(dir)) return { name, hasSnapshot: false, isJsonArray: false, contractVersion: null };
    const source = readText(join(dir, "src", "lib.rs"));
    const versionMatch = source ? /CONTRACT_VERSION\s*:\s*u32\s*=\s*(\d+)/.exec(source) : null;
    return {
      name,
      hasSnapshot: existsSync(join(dir, "abi_snapshot.json")),
      isJsonArray: readJsonArray(join(dir, "abi_snapshot.json")),
      contractVersion: versionMatch ? Number(versionMatch[1]) : null,
    };
  });
}

/** Gather every probe the pure policy functions need. Injectable for tests. */
export function collectArtifacts(root) {
  return {
    migrationProvider: readMigrationProvider(root),
    migrations: readMigrations(root),
    contracts: readContracts(root),
    envExampleText: readText(join(root, "backend", ".env.example")) ?? "",
    rollbackDoc: readText(join(root, "DEPLOYMENT.md")) ?? "",
  };
}

export function runPreflight(argv, env = process.env, collect = collectArtifacts) {
  const startedAt = Date.now();
  const args = parseArgs(argv);
  const artifacts = collect(args.root);

  if (args.dryRun) log("release_preflight_dry_run", { root: args.root, environment: args.environment });

  const findings = [
    ...checkMigrations({
      migrations: artifacts.migrations,
      provider: artifacts.migrationProvider,
      allowlist: args.allow,
    }),
    ...checkAbiSnapshots({ contracts: artifacts.contracts }),
    ...checkConfig({ envExampleText: artifacts.envExampleText, envValues: env, environment: args.environment }),
    ...checkRollback({ migrations: artifacts.migrations, rollbackDoc: artifacts.rollbackDoc }),
  ];

  const result = {
    ...summarize(findings),
    environment: args.environment,
    root: args.root,
    latencyMs: Date.now() - startedAt,
  };

  for (const f of findings) {
    log(f.level === "error" ? "release_preflight_blocked" : "release_preflight_warning", {
      check: f.check,
      code: f.code,
      artifact: f.artifact,
      message: f.message,
    });
  }
  log("release_preflight_result", {
    pass: result.pass,
    errorCount: result.errorCount,
    warningCount: result.warningCount,
    latencyMs: result.latencyMs,
  });

  if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2));
  if (env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `## Release preflight (${args.environment}): ${result.pass ? "✅ pass" : "❌ blocked"}`,
      "",
      `Errors: ${result.errorCount}, warnings: ${result.warningCount}`,
      "",
      ...findings.map((f) => `- [${f.level}] ${f.check}/${f.code} (${f.artifact}): ${f.message}`),
    ];
    writeFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`, { flag: "a" });
  }

  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(runPreflight(process.argv.slice(2)).pass ? 0 : 1);
  } catch (error) {
    process.stderr.write(`release-preflight: ${error.message}\n`);
    process.exit(2);
  }
}
