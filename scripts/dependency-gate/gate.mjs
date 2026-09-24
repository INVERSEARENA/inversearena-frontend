#!/usr/bin/env node
// Dependency threat gate CLI (#1457).
//
//   node scripts/dependency-gate/gate.mjs \
//     --npm backend=backend-audit.json \
//     --pnpm frontend=frontend-audit.json \
//     --cargo contract=cargo-audit.json \
//     --exceptions .github/dependency-exceptions.json \
//     [--summary-out gate-summary.json] [--now 2026-01-01T00:00:00Z]
//
// Exit codes: 0 pass, 1 blocked (advisory, invalid exception, or a report
// that is missing/unparseable — the gate fails closed), 2 usage error.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  evaluateGate,
  normalizeCargoAudit,
  normalizeNpmAudit,
  normalizePnpmAudit,
  validateExceptions,
} from "./policy.mjs";

const NORMALIZERS = { npm: normalizeNpmAudit, pnpm: normalizePnpmAudit, cargo: normalizeCargoAudit };

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

export function parseArgs(argv) {
  const args = { reports: [], exceptions: null, summaryOut: null, now: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    i += 1;
    if (flag in { "--npm": 1, "--pnpm": 1, "--cargo": 1 }) {
      const eq = value.indexOf("=");
      if (eq <= 0) throw new Error(`${flag} expects <source>=<path>`);
      args.reports.push({ kind: flag.slice(2), source: value.slice(0, eq), path: value.slice(eq + 1) });
    } else if (flag === "--exceptions") args.exceptions = value;
    else if (flag === "--summary-out") args.summaryOut = value;
    else if (flag === "--now") args.now = value;
    else throw new Error(`unknown flag ${flag}`);
  }
  if (args.reports.length === 0) throw new Error("at least one report is required");
  if (!args.exceptions) throw new Error("--exceptions is required");
  return args;
}

function readJson(path) {
  const text = readFileSync(path, "utf8");
  // Audit tools occasionally prefix JSON with warnings; start at the first brace.
  const start = text.indexOf("{");
  if (start < 0) throw new Error("no JSON object found");
  return JSON.parse(text.slice(start));
}

function markdown(result) {
  const lines = [`## Dependency threat gate: ${result.pass ? "✅ pass" : "❌ blocked"}`, ""];
  const row = (f) => `| ${f.ecosystem} | ${f.package} | ${f.id} | ${f.severity}${f.sensitive ? " (sensitive)" : ""} | ${f.source} |`;
  if (result.blocked.length) {
    lines.push("### Blocking advisories", "", "| Ecosystem | Package | Advisory | Severity | Report |", "|---|---|---|---|---|", ...result.blocked.map(row), "");
    lines.push("Fix by upgrading, or add a reviewed entry (max 90 days) to `.github/dependency-exceptions.json`.", "");
  }
  if (result.excepted.length) {
    lines.push("### Accepted by exception", "", ...result.excepted.map(({ finding, exception }) => `- ${finding.package} ${finding.id} — ${exception.reason} (approved by ${exception.approvedBy}, expires ${exception.expires})`), "");
  }
  if (result.unavailable.length) lines.push("### Reports unavailable (fail closed)", "", ...result.unavailable.map((u) => `- ${u}`), "");
  if (result.invalid.length) lines.push("### Invalid exceptions", "", ...result.invalid.map((i) => `- ${JSON.stringify(i.entry)}: ${i.problems.join(", ")}`), "");
  if (result.expired.length) lines.push("### Expired exceptions (remove or re-review)", "", ...result.expired.map((e) => `- ${e.package} ${e.id} expired ${e.expires}`), "");
  if (result.unused.length) lines.push("### Unused exceptions", "", ...result.unused.map((e) => `- ${e.package} ${e.id}`), "");
  lines.push(`Non-blocking advisories reported: ${result.reported.length}`);
  return lines.join("\n");
}

export function runGate(argv, env = process.env) {
  const startedAt = Date.now();
  const args = parseArgs(argv);
  const now = args.now ? new Date(args.now) : new Date();

  const findings = [];
  const unavailable = [];
  for (const report of args.reports) {
    try {
      const parsed = NORMALIZERS[report.kind](readJson(report.path), report.source);
      findings.push(...parsed);
      log("dependency_gate_report", { source: report.source, kind: report.kind, findings: parsed.length });
    } catch (error) {
      unavailable.push(`${report.source} (${report.kind}): ${error.message}`);
      log("dependency_gate_report_unavailable", { source: report.source, kind: report.kind, error: error.message });
    }
  }

  let exceptionsFile;
  try {
    exceptionsFile = readJson(args.exceptions);
  } catch (error) {
    exceptionsFile = { invalid: error.message };
  }
  const result = evaluateGate(findings, validateExceptions(exceptionsFile, now), unavailable);

  for (const f of result.blocked) log("dependency_gate_blocked", { ecosystem: f.ecosystem, package: f.package, id: f.id, severity: f.severity, source: f.source });
  for (const { finding, exception } of result.excepted) log("dependency_gate_excepted", { package: finding.package, id: finding.id, expires: exception.expires });
  log("dependency_gate_result", {
    pass: result.pass, blocked: result.blocked.length, excepted: result.excepted.length, reported: result.reported.length,
    invalidExceptions: result.invalid.length, expiredExceptions: result.expired.length, unavailable: result.unavailable.length,
    latencyMs: Date.now() - startedAt,
  });

  if (args.summaryOut) writeFileSync(args.summaryOut, JSON.stringify(result, null, 2));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown(result)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(runGate(process.argv.slice(2)).pass ? 0 : 1);
  } catch (error) {
    process.stderr.write(`dependency-gate: ${error.message}\n`);
    process.exit(2);
  }
}
