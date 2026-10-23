#!/usr/bin/env node
/**
 * Per-crate contract test coverage thresholds (#1651).
 *
 * Reads the `cargo llvm-cov report --json --summary-only` export, aggregates
 * line, branch and function coverage per workspace crate, and enforces the
 * minimums in contract/coverage-thresholds.json:
 *
 *   node contract/scripts/coverage.mjs            # check; exit 1 below a threshold
 *   node contract/scripts/coverage.mjs --ratchet  # raise thresholds to current coverage
 *   node contract/scripts/coverage.mjs --summary <path>  # default target/coverage/summary.json
 *
 * Thresholds only move up: --ratchet raises each to the floor of the current
 * percentage and never lowers one. Lowering a threshold is a deliberate,
 * reviewed edit to the JSON file.
 *
 * The markdown table is written to target/coverage/summary.md and appended to
 * $GITHUB_STEP_SUMMARY when set. See contract/docs/COVERAGE.md.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONTRACT = join(dirname(fileURLToPath(import.meta.url)), "..");
const THRESHOLDS = join(CONTRACT, "coverage-thresholds.json");
const DEFAULT_SUMMARY = join(CONTRACT, "target", "coverage", "summary.json");

/** Metrics with enforced minimums. Functions are reported only. */
export const GATED = ["lines", "branches"];

const percent = ({ covered, count }) => (count === 0 ? 100 : (covered / count) * 100);

/** Sum llvm-cov per-file summaries into per-crate totals, keyed by crate directory. */
export function aggregate(summary, contractDir) {
  const crates = {};
  for (const file of summary.data.flatMap((export_) => export_.files)) {
    const path = relative(contractDir, file.filename);
    if (path.startsWith("..")) continue;
    const crate = path.split(sep)[0];
    crates[crate] ??= { lines: { covered: 0, count: 0 }, branches: { covered: 0, count: 0 }, functions: { covered: 0, count: 0 } };
    for (const metric of ["lines", "branches", "functions"]) {
      crates[crate][metric].covered += file.summary[metric].covered;
      crates[crate][metric].count += file.summary[metric].count;
    }
  }
  return crates;
}

/** Check per-crate coverage against minimums. */
export function check(crates, thresholds) {
  const rows = [];
  const names = [...new Set([...Object.keys(crates), ...Object.keys(thresholds.crates)])].sort();
  for (const crate of names) {
    const measured = crates[crate];
    const minimum = thresholds.crates[crate];
    const row = { crate, measured, minimum, problems: [], notes: [] };
    if (!measured) {
      row.problems.push("no coverage data");
    } else if (!minimum) {
      row.problems.push("no threshold (run with --ratchet)");
    } else {
      for (const metric of GATED) {
        const value = percent(measured[metric]);
        if (value < minimum[metric]) {
          row.problems.push(`${metric} ${value.toFixed(2)}% < ${minimum[metric]}%`);
        } else if (Math.floor(value) > minimum[metric]) {
          row.notes.push(`${metric} can ratchet to ${Math.floor(value)}%`);
        }
      }
    }
    rows.push(row);
  }
  return { rows, failed: rows.some((row) => row.problems.length > 0) };
}

/** Raise each threshold to the floor of current coverage; never lower one. */
export function ratchet(crates, thresholds) {
  const next = { ...thresholds, crates: { ...thresholds.crates } };
  for (const [crate, measured] of Object.entries(crates)) {
    const current = { ...next.crates[crate] };
    for (const metric of GATED) {
      current[metric] = Math.max(current[metric] ?? 0, Math.floor(percent(measured[metric])));
    }
    next.crates[crate] = current;
  }
  next.crates = Object.fromEntries(Object.entries(next.crates).sort(([a], [b]) => a.localeCompare(b)));
  return next;
}

function cell(measured, metric) {
  if (!measured) return "—";
  const { covered, count } = measured[metric];
  return `${percent(measured[metric]).toFixed(2)}% (${covered}/${count})`;
}

export function renderMarkdown({ rows, failed }) {
  const lines = [
    "## Contract test coverage (#1651)",
    "",
    failed
      ? "❌ Coverage below threshold. Add tests for the uncovered paths (see the HTML report artifact)."
      : "✅ Every crate meets its line and branch coverage thresholds.",
    "",
    "| Crate | Lines | Branches | Functions | Min lines | Min branches | Status |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const row of rows) {
    const status = row.problems.length ? `❌ ${row.problems.join("; ")}` : row.notes.length ? `⬆️ ${row.notes.join("; ")}` : "✅";
    lines.push(
      `| \`${row.crate}\` | ${cell(row.measured, "lines")} | ${cell(row.measured, "branches")} | ${cell(row.measured, "functions")} | ` +
        `${row.minimum ? `${row.minimum.lines}%` : "—"} | ${row.minimum ? `${row.minimum.branches}%` : "—"} | ${status} |`,
    );
  }
  lines.push("", "Test-only modules are excluded. ⬆️ means coverage rose: run `node contract/scripts/coverage.mjs --ratchet` and commit the thresholds.", "");
  return lines.join("\n");
}

function main(argv) {
  const summaryFlag = argv.indexOf("--summary");
  const summaryPath = summaryFlag >= 0 ? argv[summaryFlag + 1] : DEFAULT_SUMMARY;
  const crates = aggregate(JSON.parse(readFileSync(summaryPath, "utf8")), CONTRACT);
  const thresholds = JSON.parse(readFileSync(THRESHOLDS, "utf8"));

  if (argv.includes("--ratchet")) {
    writeFileSync(THRESHOLDS, `${JSON.stringify(ratchet(crates, thresholds), null, 2)}\n`);
    console.log(`Ratcheted ${THRESHOLDS}`);
    return 0;
  }

  const result = check(crates, thresholds);
  const markdown = renderMarkdown(result);
  writeFileSync(join(dirname(summaryPath), "summary.md"), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown);
  return result.failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
