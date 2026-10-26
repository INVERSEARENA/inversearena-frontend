#!/usr/bin/env node
/**
 * Per-entry-point contract resource cost benchmarks (#1649).
 *
 * Runs the `cost-bench` crate, which drives each contract's compiled WASM and
 * records `env.cost_estimate().resources()` per entry point, then compares the
 * results against contract/cost-baseline.json:
 *
 *   node contract/scripts/cost-bench.mjs            # build, run, compare; exit 1 on regression
 *   node contract/scripts/cost-bench.mjs --bless    # build, run, rewrite the baseline
 *   node contract/scripts/cost-bench.mjs --no-build # reuse the WASM already in target/
 *
 * The WASM is built with --remap-path-prefix so panic-location strings do not
 * embed the builder's home directory: otherwise the binary, and the VM's
 * parsing cost, would differ between a laptop and CI. Costs also depend on the
 * rustc version, which the baseline records; re-bless after a toolchain or
 * soroban-sdk upgrade (see contract/docs/COST_BENCHMARKS.md).
 *
 * The markdown table is written to target/cost-bench/summary.md and appended
 * to $GITHUB_STEP_SUMMARY when set.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONTRACT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(CONTRACT, "cost-baseline.json");
const OUT_DIR = join(CONTRACT, "target", "cost-bench");
const RESULTS_DIR = join(OUT_DIR, "results");

/** Metrics compared against the baseline, with their table labels. */
export const METRICS = [
  ["instructions", "CPU instr"],
  ["mem_bytes", "Memory"],
  ["read_entries", "Read entries"],
  ["write_entries", "Write entries"],
  ["read_bytes", "Read bytes"],
  ["write_bytes", "Write bytes"],
  ["events_bytes", "Event bytes"],
];

/** Default max regression per metric, in percent. 0 = any increase fails. */
export const DEFAULT_THRESHOLDS = {
  instructions: 5,
  mem_bytes: 5,
  read_entries: 0,
  write_entries: 0,
  read_bytes: 5,
  write_bytes: 5,
  events_bytes: 10,
};

/** Per-transaction network limits (soroban-env-host defaults, matching pubnet). */
export const DEFAULT_NETWORK_LIMITS = {
  instructions: 100_000_000,
  mem_bytes: 40 * 1024 * 1024,
};

export const keyOf = (result) => `${result.name}@${result.players}`;

const pct = (current, base) => (base === 0 ? (current === 0 ? 0 : Infinity) : ((current - base) / base) * 100);

/**
 * Compare benchmark results with a baseline.
 *
 * Returns one row per benchmark plus `failed`, which is true when any metric
 * regressed past its threshold, a benchmark is new or missing, or a result
 * newly crossed a network limit. Results that were already over a limit in the
 * baseline are reported as known, not failed, so a pre-existing problem does
 * not block unrelated changes.
 */
export function compare(baseline, results) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...baseline.thresholds };
  const limits = { ...DEFAULT_NETWORK_LIMITS, ...baseline.networkLimits };
  const base = baseline.benchmarks ?? {};
  const seen = new Set();
  const rows = [];

  for (const result of [...results].sort((a, b) => keyOf(a).localeCompare(keyOf(b), "en", { numeric: true }))) {
    const key = keyOf(result);
    seen.add(key);
    const before = base[key];
    const row = { key, name: result.name, players: result.players, current: result, baseline: before, deltas: {}, problems: [], notes: [] };
    if (!before) {
      row.problems.push("not in baseline (run with --bless)");
    } else {
      for (const [metric] of METRICS) {
        const delta = pct(result[metric], before[metric]);
        row.deltas[metric] = delta;
        if (delta > thresholds[metric]) {
          row.problems.push(`${metric} ${fmtPct(delta)} > ${thresholds[metric]}%`);
        } else if (delta < -thresholds[metric] && thresholds[metric] > 0) {
          row.notes.push(`${metric} improved ${fmtPct(delta)}`);
        }
      }
    }
    for (const [metric, limit] of Object.entries(limits)) {
      if (result[metric] <= limit) continue;
      if (before && before[metric] > limit) {
        row.notes.push(`${metric} over network limit (known)`);
      } else {
        row.problems.push(`${metric} ${fmtNum(result[metric])} exceeds network limit ${fmtNum(limit)}`);
      }
    }
    rows.push(row);
  }

  for (const key of Object.keys(base)) {
    if (!seen.has(key)) {
      rows.push({ key, name: key, players: "", current: null, baseline: base[key], deltas: {}, problems: ["missing from results"], notes: [] });
    }
  }

  return { rows, failed: rows.some((row) => row.problems.length > 0), thresholds };
}

/** Baseline object for the given results, keeping existing thresholds and limits. */
export function bless(previous, results, meta) {
  const benchmarks = {};
  for (const result of [...results].sort((a, b) => keyOf(a).localeCompare(keyOf(b), "en", { numeric: true }))) {
    const entry = {};
    for (const [metric] of METRICS) entry[metric] = result[metric];
    entry.fee_stroops = result.fee_stroops;
    benchmarks[keyOf(result)] = entry;
  }
  return {
    version: 1,
    toolchain: meta.toolchain,
    sorobanSdk: meta.sorobanSdk,
    thresholds: { ...DEFAULT_THRESHOLDS, ...previous?.thresholds },
    networkLimits: { ...DEFAULT_NETWORK_LIMITS, ...previous?.networkLimits },
    benchmarks,
  };
}

function fmtNum(n) {
  return Number(n).toLocaleString("en-US");
}

function fmtPct(p) {
  if (!Number.isFinite(p)) return "new";
  const sign = p > 0 ? "+" : "";
  return `${sign}${p.toFixed(2)}%`;
}

function cell(row, metric) {
  if (!row.current) return "—";
  const delta = row.deltas[metric];
  if (delta === undefined || delta === 0) return fmtNum(row.current[metric]);
  return `${fmtNum(row.current[metric])} (${fmtPct(delta)})`;
}

export function renderMarkdown({ rows, failed, thresholds }, meta = {}) {
  const lines = [
    "## Contract resource costs (#1649)",
    "",
    failed
      ? "❌ Cost regression. Fix it, or re-bless the baseline with `node contract/scripts/cost-bench.mjs --bless` if the increase is intended."
      : "✅ No cost regressions against `contract/cost-baseline.json`.",
    "",
    `| Benchmark | Players | ${METRICS.map(([, label]) => label).join(" | ")} | Fee (stroops) | Status |`,
    `| --- | ---: | ${METRICS.map(() => "---:").join(" | ")} | ---: | --- |`,
  ];
  for (const row of rows) {
    const status = row.problems.length ? `❌ ${row.problems.join("; ")}` : row.notes.length ? `⚠️ ${row.notes.join("; ")}` : "✅";
    const fee = row.current ? fmtNum(row.current.fee_stroops) : "—";
    lines.push(`| \`${row.name}\` | ${row.players} | ${METRICS.map(([metric]) => cell(row, metric)).join(" | ")} | ${fee} | ${status} |`);
  }
  lines.push(
    "",
    `Thresholds: ${METRICS.map(([metric]) => `${metric} ${thresholds[metric]}%`).join(", ")}.`,
    meta.toolchain ? `Toolchain: \`${meta.toolchain}\`, soroban-sdk ${meta.sorobanSdk}.` : "",
    "",
  );
  return lines.join("\n");
}

function sorobanSdkVersion() {
  const lock = readFileSync(join(CONTRACT, "Cargo.lock"), "utf8");
  const match = lock.match(/name = "soroban-sdk"\nversion = "([^"]+)"/);
  return match ? match[1] : "unknown";
}

function run(cmd, args, env = {}) {
  execFileSync(cmd, args, { cwd: CONTRACT, stdio: "inherit", env: { ...process.env, ...env } });
}

function main(argv) {
  const blessMode = argv.includes("--bless");
  const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
  const remap = `--remap-path-prefix=${cargoHome}=/cargo --remap-path-prefix=${CONTRACT}=/build`;

  if (!argv.includes("--no-build")) {
    run("cargo", ["build", "--workspace", "--target", "wasm32v1-none", "--release"], {
      RUSTFLAGS: `${process.env.RUSTFLAGS ?? ""} ${remap}`.trim(),
    });
  }
  rmSync(RESULTS_DIR, { recursive: true, force: true });
  run("cargo", ["test", "-p", "cost-bench", "--test", "cost_bench", "--", "--test-threads=1"], { COST_BENCH_OUT: RESULTS_DIR });

  const results = readdirSync(RESULTS_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8")));
  const meta = {
    toolchain: execFileSync("rustc", ["--version"], { cwd: CONTRACT, encoding: "utf8" }).trim(),
    sorobanSdk: sorobanSdkVersion(),
  };
  const previous = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;

  if (blessMode) {
    writeFileSync(BASELINE, `${JSON.stringify(bless(previous, results, meta), null, 2)}\n`);
    console.log(`Blessed ${results.length} benchmarks into ${BASELINE}`);
    return 0;
  }
  if (!previous) {
    console.error(`No baseline at ${BASELINE}; run with --bless first.`);
    return 1;
  }
  if (previous.toolchain && previous.toolchain !== meta.toolchain) {
    console.warn(`::warning::Baseline was recorded with ${previous.toolchain}, running ${meta.toolchain}; costs may shift.`);
  }

  const comparison = compare(previous, results);
  const markdown = renderMarkdown(comparison, meta);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "summary.md"), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown);
  return comparison.failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
