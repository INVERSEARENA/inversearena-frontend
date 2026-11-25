/**
 * Unit tests for backend/tests/load/compare-baseline.js
 *
 * These tests exercise the comparison logic in isolation without running k6.
 * They use Node's built-in test runner (tsx --test) to stay consistent with
 * the rest of the backend unit-test suite.
 *
 * Because compare-baseline.js calls process.exit() we mock it via a child
 * process: each test case spawns compare-baseline.js as a subprocess, feeds it
 * synthetic k6 JSON output files, and asserts the exit code and stdout/stderr.
 */

import { test } from "node:test";
import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("./compare-baseline.js", import.meta.url).pathname;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Write synthetic k6 JSON output lines for the metrics we care about.
 *
 * k6 --out json emits one JSON object per line.  We emit two types:
 *   • "Point" records (per-sample values)
 *   • "Metric" summary records with a `values` map (written at run end)
 *
 * For the comparator the "Metric" summary records matter most.
 */
function buildK6Json(/** @type {Record<string, Record<string, number>>} */ metrics) {
  const lines = [];

  for (const [name, aggregates] of Object.entries(metrics)) {
    // Metric summary record
    lines.push(
      JSON.stringify({
        type: "Metric",
        data: {
          name,
          type: "trend",
          contains: "time",
          values: aggregates,
        },
      }),
    );
  }

  return lines.join("\n") + "\n";
}

/**
 * Run compare-baseline.js as a child process.
 *
 * @param {string} baselineContent  JSON string for the baseline file (or "" to skip creating it)
 * @param {string} latestContent    JSON string for the latest file
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
function runComparator(baselineContent, latestContent) {
  const dir = join(tmpdir(), `k6-compare-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });

  const baselinePath = join(dir, "baseline.json");
  const latestPath = join(dir, "latest.json");

  if (baselineContent) {
    writeFileSync(baselinePath, baselineContent);
  }
  writeFileSync(latestPath, latestContent);

  const result = spawnSync(
    process.execPath,
    [SCRIPT, baselinePath, latestPath],
    { encoding: "utf8" },
  );

  // Clean up temp files.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors in tests.
  }

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    // Baseline path for assertions in the "first run" test.
    baselinePath,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("exits 0 when all metrics are within tolerance", () => {
  const baseline = buildK6Json({
    http_req_duration: { "p(95)": 200 },
    http_req_failed: { rate: 0.005 },
    sse_time_to_first_event: { "p(95)": 400 },
    sse_connect_errors: { rate: 0.002 },
    arena_list_valid_response: { rate: 0.99 },
    arena_state_duration: { "p(95)": 150 },
    burst_reads_completed: { count: 600 },
  });

  // Latest is identical to baseline — zero delta.
  const { exitCode } = runComparator(baseline, baseline);
  assert.strictEqual(exitCode, 0);
});

test("exits 0 when metrics improve (lower is better goes down)", () => {
  const baseline = buildK6Json({
    http_req_duration: { "p(95)": 300 },
    http_req_failed: { rate: 0.008 },
    sse_time_to_first_event: { "p(95)": 500 },
    sse_connect_errors: { rate: 0.004 },
    arena_list_valid_response: { rate: 0.97 },
    arena_state_duration: { "p(95)": 300 },
    burst_reads_completed: { count: 500 },
  });

  // Latest is better on everything.
  const latest = buildK6Json({
    http_req_duration: { "p(95)": 150 },
    http_req_failed: { rate: 0.002 },
    sse_time_to_first_event: { "p(95)": 250 },
    sse_connect_errors: { rate: 0.001 },
    arena_list_valid_response: { rate: 0.99 },
    arena_state_duration: { "p(95)": 120 },
    burst_reads_completed: { count: 650 },
  });

  const { exitCode } = runComparator(baseline, latest);
  assert.strictEqual(exitCode, 0);
});

test("exits 1 when p95 http_req_duration regresses beyond 10 % tolerance", () => {
  const baseline = buildK6Json({
    http_req_duration: { "p(95)": 200 },
    http_req_failed: { rate: 0.001 },
    sse_time_to_first_event: { "p(95)": 400 },
    sse_connect_errors: { rate: 0.001 },
    arena_list_valid_response: { rate: 0.99 },
    arena_state_duration: { "p(95)": 150 },
    burst_reads_completed: { count: 600 },
  });

  // Latest p95 latency is 40 % worse (200 → 280).
  const latest = buildK6Json({
    http_req_duration: { "p(95)": 280 },
    http_req_failed: { rate: 0.001 },
    sse_time_to_first_event: { "p(95)": 400 },
    sse_connect_errors: { rate: 0.001 },
    arena_list_valid_response: { rate: 0.99 },
    arena_state_duration: { "p(95)": 150 },
    burst_reads_completed: { count: 600 },
  });

  const { exitCode, stderr } = runComparator(baseline, latest);
  assert.strictEqual(exitCode, 1);
  assert.match(stderr, /REGRESSION/i);
  assert.match(stderr, /http_req_duration/);
});

test("exits 1 when SSE connection error rate regresses beyond tolerance", () => {
  const baseline = buildK6Json({
    http_req_duration: { "p(95)": 200 },
    http_req_failed: { rate: 0.001 },
    sse_time_to_first_event: { "p(95)": 300 },
    sse_connect_errors: { rate: 0.001 },
    arena_list_valid_response: { rate: 0.99 },
    arena_state_duration: { "p(95)": 150 },
    burst_reads_completed: { count: 600 },
  });

  // SSE error rate jumps from 0.1 % to 2 % — well beyond 0.5 % tolerance.
  const latest = buildK6Json({
    http_req_duration: { "p(95)": 200 },
    http_req_failed: { rate: 0.001 },
    sse_time_to_first_event: { "p(95)": 300 },
    sse_connect_errors: { rate: 0.02 },
    arena_list_valid_response: { rate: 0.99 },
    arena_state_duration: { "p(95)": 150 },
    burst_reads_completed: { count: 600 },
  });

  const { exitCode, stderr } = runComparator(baseline, latest);
  assert.strictEqual(exitCode, 1);
  assert.match(stderr, /sse_connect_errors/);
});

test("exits 1 when arena_list_valid_response rate drops below tolerance", () => {
  const baseline = buildK6Json({
    http_req_duration: { "p(95)": 200 },
    http_req_failed: { rate: 0.001 },
    sse_time_to_first_event: { "p(95)": 300 },
    sse_connect_errors: { rate: 0.001 },
    arena_list_valid_response: { rate: 0.99 },
    arena_state_duration: { "p(95)": 150 },
    burst_reads_completed: { count: 600 },
  });

  // Valid response rate drops from 99 % to 80 % — exceeds 2 % tolerance.
  const latest = buildK6Json({
    http_req_duration: { "p(95)": 200 },
    http_req_failed: { rate: 0.001 },
    sse_time_to_first_event: { "p(95)": 300 },
    sse_connect_errors: { rate: 0.001 },
    arena_list_valid_response: { rate: 0.80 },
    arena_state_duration: { "p(95)": 150 },
    burst_reads_completed: { count: 600 },
  });

  const { exitCode, stderr } = runComparator(baseline, latest);
  assert.strictEqual(exitCode, 1);
  assert.match(stderr, /arena_list_valid_response/);
});

test("copies latest to baseline and exits 0 when no baseline file exists", () => {
  const latest = buildK6Json({
    http_req_duration: { "p(95)": 200 },
    http_req_failed: { rate: 0.001 },
    sse_time_to_first_event: { "p(95)": 300 },
    sse_connect_errors: { rate: 0.001 },
    arena_list_valid_response: { rate: 0.99 },
    arena_state_duration: { "p(95)": 150 },
    burst_reads_completed: { count: 600 },
  });

  // Pass "" as baseline content — runComparator will NOT create the baseline file.
  const { exitCode, stdout } = runComparator("", latest);
  assert.strictEqual(exitCode, 0);
  assert.match(stdout, /Copying latest run as new baseline/i);
});

test("exits 2 when called without arguments", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.strictEqual(result.status, 2);
});

test("exits 0 when metrics regress within tolerance band (exactly at boundary)", () => {
  const baseline = buildK6Json({
    http_req_duration: { "p(95)": 200 },
    http_req_failed: { rate: 0.005 },
    sse_time_to_first_event: { "p(95)": 400 },
    sse_connect_errors: { rate: 0.002 },
    arena_list_valid_response: { rate: 0.99 },
    arena_state_duration: { "p(95)": 150 },
    burst_reads_completed: { count: 600 },
  });

  // Latest p95 latency is exactly 10 % worse (200 → 220) — at the boundary, not over.
  const latest = buildK6Json({
    http_req_duration: { "p(95)": 220 },
    http_req_failed: { rate: 0.005 },
    sse_time_to_first_event: { "p(95)": 440 },
    sse_connect_errors: { rate: 0.002 },
    arena_list_valid_response: { rate: 0.99 },
    arena_state_duration: { "p(95)": 165 },
    burst_reads_completed: { count: 600 },
  });

  const { exitCode } = runComparator(baseline, latest);
  assert.strictEqual(exitCode, 0);
});
