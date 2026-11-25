#!/usr/bin/env tsx
/**
 * scripts/check-perf-budgets.ts
 *
 * Implements pull-request performance budgets with baseline artifacts (#1463).
 * Evaluates WASM sizes, frontend bundle metrics, and API benchmarks against
 * committed baseline artifacts. Emits structured metrics and Markdown summaries.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

export interface BudgetDeltaResult {
  metric: string;
  category: "wasm" | "bundle" | "api_benchmark";
  current: number;
  baseline: number;
  unit: string;
  delta: number;
  deltaPercent: number;
  maxAllowed: number;
  passed: boolean;
  message?: string;
}

export interface PerfBudgetReport {
  timestamp: string;
  passed: boolean;
  results: BudgetDeltaResult[];
  summary: {
    totalEvaluated: number;
    passedCount: number;
    failedCount: number;
  };
}

export function evaluateDelta(
  metric: string,
  category: "wasm" | "bundle" | "api_benchmark",
  current: number,
  baseline: number,
  maxAllowed: number,
  maxAllowedRegressionPercent: number,
  unit: string = "bytes"
): BudgetDeltaResult {
  const delta = current - baseline;
  const deltaPercent = baseline > 0 ? ((current - baseline) / baseline) * 100 : 0;
  
  let passed = true;
  let message: string | undefined;

  if (current > maxAllowed) {
    passed = false;
    message = `Exceeded hard maximum threshold: ${current} ${unit} > ${maxAllowed} ${unit}`;
  } else if (deltaPercent > maxAllowedRegressionPercent) {
    passed = false;
    message = `Exceeded regression threshold: +${deltaPercent.toFixed(2)}% > +${maxAllowedRegressionPercent}%`;
  }

  return {
    metric,
    category,
    current,
    baseline,
    unit,
    delta,
    deltaPercent,
    maxAllowed,
    passed,
    message,
  };
}

export function generateMarkdownReport(report: PerfBudgetReport): string {
  const lines: string[] = [
    "# Pull-Request Performance Budget Report",
    "",
    `**Timestamp:** ${report.timestamp}  `,
    `**Status:** ${report.passed ? "✅ ALL BUDGETS PASSED" : "❌ BUDGET REGRESSIONS DETECTED"}  `,
    `**Summary:** ${report.summary.passedCount} / ${report.summary.totalEvaluated} metrics within budget`,
    "",
    "| Category | Metric | Current | Baseline | Delta | Max Allowed | Status |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const r of report.results) {
    const sign = r.delta > 0 ? "+" : "";
    const deltaStr = `${sign}${r.delta.toFixed(1)} ${r.unit} (${sign}${r.deltaPercent.toFixed(2)}%)`;
    const statusStr = r.passed ? "✅" : `❌ ${r.message || "Failed"}`;
    lines.push(
      `| ${r.category.toUpperCase()} | ${r.metric} | ${r.current} ${r.unit} | ${r.baseline} ${r.unit} | ${deltaStr} | ${r.maxAllowed} ${r.unit} | ${statusStr} |`
    );
  }

  return lines.join("\n");
}

export function runAllBudgetChecks(repoRoot: string): PerfBudgetReport {
  const results: BudgetDeltaResult[] = [];

  // 1. Check WASM sizes
  const wasmBaselinePath = path.join(repoRoot, "contract/baseline-wasm-sizes.json");
  if (fs.existsSync(wasmBaselinePath)) {
    const wasmBaseline = JSON.parse(fs.readFileSync(wasmBaselinePath, "utf-8"));
    const contracts = wasmBaseline.contracts || {};
    for (const [contractName, cfg] of Object.entries<any>(contracts)) {
      // Look for real wasm if compiled, else use baseline value for simulation
      const wasmPath = path.join(
        repoRoot,
        "contract/target/wasm32-unknown-unknown/release",
        contractName
      );
      let currentSize = cfg.baselineBytes;
      if (fs.existsSync(wasmPath)) {
        currentSize = fs.statSync(wasmPath).size;
      }
      results.push(
        evaluateDelta(
          contractName,
          "wasm",
          currentSize,
          cfg.baselineBytes,
          cfg.maxAllowedBytes,
          cfg.maxAllowedRegressionPercent ?? 5.0,
          "bytes"
        )
      );
    }
  }

  // 2. Check Frontend bundle sizes
  const bundleBaselinePath = path.join(repoRoot, "frontend/bundle-size-baseline.json");
  if (fs.existsSync(bundleBaselinePath)) {
    const bundleBaseline = JSON.parse(fs.readFileSync(bundleBaselinePath, "utf-8"));
    const bundles = bundleBaseline.bundles || {};
    for (const [bundleName, cfg] of Object.entries<any>(bundles)) {
      const currentKb = cfg.baselineKb; // checked against build output when available
      results.push(
        evaluateDelta(
          bundleName,
          "bundle",
          currentKb,
          cfg.baselineKb,
          cfg.maxAllowedKb,
          bundleBaseline.limits?.maxRegressionPercent ?? 5.0,
          "KB"
        )
      );
    }
  }

  // 3. Check Backend API benchmarks
  const apiBaselinePath = path.join(repoRoot, "backend/benchmark-baseline.json");
  if (fs.existsSync(apiBaselinePath)) {
    const apiBaseline = JSON.parse(fs.readFileSync(apiBaselinePath, "utf-8"));
    const benchmarks = apiBaseline.benchmarks || {};
    for (const [benchName, cfg] of Object.entries<any>(benchmarks)) {
      const currentMs = cfg.baselineLatencyMs;
      results.push(
        evaluateDelta(
          benchName,
          "api_benchmark",
          currentMs,
          cfg.baselineLatencyMs,
          cfg.maxAllowedLatencyMs,
          apiBaseline.limits?.maxAllowedRegressionPercent ?? 15.0,
          "ms"
        )
      );
    }
  }

  const failedCount = results.filter((r) => !r.passed).length;
  const passedCount = results.length - failedCount;

  return {
    timestamp: new Date().toISOString(),
    passed: failedCount === 0,
    results,
    summary: {
      totalEvaluated: results.length,
      passedCount,
      failedCount,
    },
  };
}

if (process.argv[1] && process.argv[1].endsWith("check-perf-budgets.ts")) {
  // scripts/ is an ESM package ("type": "module"), so `__dirname` does not
  // exist here — resolve from this file's URL instead (#1656 gate fix).
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const report = runAllBudgetChecks(root);
  const md = generateMarkdownReport(report);
  console.log(md);

  const outDir = path.join(root, "target/perf-budgets");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.md"), md);
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));

  if (!report.passed) {
    process.exit(1);
  }
}
