#!/usr/bin/env node
/**
 * compare-baseline.js
 *
 * Compares a freshly generated k6 JSON output file against a stored baseline
 * and exits non-zero when any tracked metric regresses beyond the configured
 * tolerance.
 *
 * Usage:
 *   node backend/tests/load/compare-baseline.js \
 *     <baseline-file> <latest-file>
 *
 * Example:
 *   node backend/tests/load/compare-baseline.js \
 *     backend/tests/load/baselines/baseline.json \
 *     backend/tests/load/baselines/latest.json
 *
 * The k6 JSON output format used here is produced with:
 *   k6 run --out json=<file> …
 *
 * Only summary metrics (type === "Point", metric ends with a known aggregate
 * suffix) are compared.  The script reads both files line-by-line so it
 * handles arbitrarily large output without loading everything into memory.
 *
 * Exit codes:
 *   0 — no regressions detected (or baseline file does not exist yet)
 *   1 — one or more regressions detected (printed to stderr)
 */

"use strict";

const fs = require("fs");
const readline = require("readline");
const path = require("path");

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Metrics to track and the direction they must not regress.
 *
 * Each entry:
 *   metric    — k6 metric name as it appears in the JSON output
 *   aggregate — which aggregate to compare ("p(95)", "avg", "rate", "count")
 *   direction — "lower_is_better" | "higher_is_better"
 *   tolerance — fraction by which the new value may exceed the baseline
 *               without being flagged (0.10 = 10 %).
 */
const TRACKED_METRICS = [
  // HTTP latency
  {
    metric: "http_req_duration",
    aggregate: "p(95)",
    direction: "lower_is_better",
    tolerance: 0.1,
  },
  // HTTP error rate
  {
    metric: "http_req_failed",
    aggregate: "rate",
    direction: "lower_is_better",
    tolerance: 0.005,
  },
  // SSE latency
  {
    metric: "sse_time_to_first_event",
    aggregate: "p(95)",
    direction: "lower_is_better",
    tolerance: 0.1,
  },
  // SSE connection error rate
  {
    metric: "sse_connect_errors",
    aggregate: "rate",
    direction: "lower_is_better",
    tolerance: 0.005,
  },
  // Arena list response validity
  {
    metric: "arena_list_valid_response",
    aggregate: "rate",
    direction: "higher_is_better",
    tolerance: 0.02,
  },
  // Arena state read latency
  {
    metric: "arena_state_duration",
    aggregate: "p(95)",
    direction: "lower_is_better",
    tolerance: 0.1,
  },
  // Burst read count
  {
    metric: "burst_reads_completed",
    aggregate: "count",
    direction: "higher_is_better",
    tolerance: 0.0,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse a k6 JSON output file (one JSON object per line) and extract the
 * final summary values for each tracked metric/aggregate pair.
 *
 * k6 emits summary metrics at the end of the run as objects with:
 *   { "type": "Metric", "data": { "name": "…", "contains": "…" } }
 * followed later by:
 *   { "type": "Point", "metric": "…", "data": { "time": "…", "value": … } }
 *
 * For aggregate metrics (Trend, Rate, Counter) k6 writes a dedicated
 * summary object at end-of-run with keys matching aggregate names.
 * We collect the LAST seen value for each (metric, aggregate) pair.
 *
 * @param {string} filePath
 * @returns {Promise<Map<string, Map<string, number>>>}
 *   Outer key: metric name.  Inner key: aggregate label.  Value: number.
 */
async function parseK6Json(filePath) {
  /** @type {Map<string, Map<string, number>>} */
  const result = new Map();

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // k6 summary line: { type: "Metric", data: { name, type, contains, thresholds, submetrics } }
    // We don't use this, but we could.

    // k6 point line: { type: "Point", metric: "…", data: { time, value, tags } }
    if (obj.type === "Point" && typeof obj.metric === "string") {
      const metricName = obj.metric;
      const value = obj.data?.value;
      if (typeof value !== "number") continue;

      // k6 uses metric names like "http_req_duration{…}" for tagged sub-metrics.
      // Strip tag selectors so we match on the base name.
      const baseName = metricName.replace(/\{[^}]*\}/, "");

      if (!result.has(baseName)) {
        result.set(baseName, new Map());
      }
      // For plain counters/gauges the "aggregate" is just "value".
      result.get(baseName).set("value", value);
    }

    // k6 end-of-run summary: { type: "Metric", … } with aggregate sub-keys
    // embedded in data.thresholds or data.values (depends on k6 version).
    if (obj.type === "Metric" && obj.data?.name) {
      const name = obj.data.name;
      const values = obj.data.values;
      if (values && typeof values === "object") {
        if (!result.has(name)) result.set(name, new Map());
        const agg = result.get(name);
        for (const [k, v] of Object.entries(values)) {
          if (typeof v === "number") agg.set(k, v);
        }
      }
    }
  }

  return result;
}

/**
 * Extract the numeric value for a tracked metric entry from a parsed results
 * map.  Returns `undefined` when the metric or aggregate is absent.
 *
 * @param {Map<string, Map<string, number>>} parsed
 * @param {{ metric: string, aggregate: string }} entry
 * @returns {number | undefined}
 */
function getValue(parsed, { metric, aggregate }) {
  const agg = parsed.get(metric);
  if (!agg) return undefined;
  // Try exact aggregate key, then "value" fallback.
  return agg.get(aggregate) ?? agg.get("value");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [, , baselinePath, latestPath] = process.argv;

  if (!baselinePath || !latestPath) {
    console.error(
      "Usage: node compare-baseline.js <baseline-file> <latest-file>",
    );
    process.exit(2);
  }

  // If the baseline does not exist yet, treat this as the first run: write the
  // latest file as the new baseline and exit 0.
  if (!fs.existsSync(baselinePath)) {
    console.log(
      `Baseline file not found at ${baselinePath}.  ` +
        `Copying latest run as new baseline.`,
    );
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.copyFileSync(latestPath, baselinePath);
    console.log(`Baseline written to ${baselinePath}`);
    process.exit(0);
  }

  if (!fs.existsSync(latestPath)) {
    console.error(`Latest results file not found at ${latestPath}`);
    process.exit(2);
  }

  console.log(`Comparing:\n  baseline: ${baselinePath}\n  latest:   ${latestPath}\n`);

  const [baseline, latest] = await Promise.all([
    parseK6Json(baselinePath),
    parseK6Json(latestPath),
  ]);

  const regressions = [];
  const rows = [];

  for (const entry of TRACKED_METRICS) {
    const baseVal = getValue(baseline, entry);
    const latestVal = getValue(latest, entry);

    const baseStr = baseVal !== undefined ? baseVal.toFixed(4) : "N/A";
    const latestStr = latestVal !== undefined ? latestVal.toFixed(4) : "N/A";

    let status = "OK";
    let regressed = false;

    if (baseVal !== undefined && latestVal !== undefined) {
      const delta = latestVal - baseVal;
      const relDelta = baseVal !== 0 ? delta / Math.abs(baseVal) : delta;

      if (entry.direction === "lower_is_better" && relDelta > entry.tolerance) {
        status = `REGRESSION (+${(relDelta * 100).toFixed(1)} %)`;
        regressed = true;
      } else if (
        entry.direction === "higher_is_better" &&
        -relDelta > entry.tolerance
      ) {
        status = `REGRESSION (${(relDelta * 100).toFixed(1)} %)`;
        regressed = true;
      } else {
        const sign = delta >= 0 ? "+" : "";
        status = `OK (${sign}${(relDelta * 100).toFixed(1)} %)`;
      }
    } else if (baseVal === undefined) {
      status = "BASELINE N/A";
    } else {
      status = "LATEST N/A";
    }

    if (regressed) {
      regressions.push(
        `  ${entry.metric} [${entry.aggregate}]: baseline=${baseStr}  latest=${latestStr}  ${status}`,
      );
    }

    rows.push(
      `  ${entry.metric.padEnd(32)} ${entry.aggregate.padEnd(8)} baseline=${baseStr.padStart(10)}  latest=${latestStr.padStart(10)}  ${status}`,
    );
  }

  console.log("Results:\n");
  rows.forEach((r) => console.log(r));

  if (regressions.length > 0) {
    console.error(`\n\nREGRESSIONS DETECTED (${regressions.length}):\n`);
    regressions.forEach((r) => console.error(r));
    process.exit(1);
  } else {
    console.log("\n\nAll metrics within tolerance. ✓");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
