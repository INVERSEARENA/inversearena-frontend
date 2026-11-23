// Tests for the dependency threat gate (#1457). Run: node --test scripts/dependency-gate/gate.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_EXCEPTION_DAYS,
  cvss3BaseScore,
  dedupeFindings,
  evaluateGate,
  isBlocking,
  isSensitivePackage,
  normalizeCargoAudit,
  normalizeNpmAudit,
  normalizePnpmAudit,
  severityFromScore,
  validateExceptions,
} from "./policy.mjs";
import { parseArgs, runGate } from "./gate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
const NOW = new Date("2026-06-01T00:00:00Z");
const inDays = (d) => new Date(NOW.getTime() + d * 86400000).toISOString().slice(0, 10);
const noExceptions = () => validateExceptions({ version: 1, exceptions: [] }, NOW);

function finding(overrides = {}) {
  return { ecosystem: "npm", source: "t", id: "GHSA-aaaa-bbbb-cccc", aliases: [], package: "left-pad", severity: "moderate", title: "", url: "", sensitive: false, ...overrides };
}

// ---- severity -----------------------------------------------------------------------

test("cvss3BaseScore matches reference scores", () => {
  assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), 9.8);
  assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H"), 10);
  assert.equal(cvss3BaseScore("CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:N"), 7.4);
  assert.equal(cvss3BaseScore("CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:N"), 0);
});

test("unparseable or v4 vectors fail safe to high", () => {
  for (const vector of [undefined, "", "garbage", "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N", "CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"]) {
    assert.equal(severityFromScore(cvss3BaseScore(vector)), "high", String(vector));
  }
});

test("severity bands at their boundaries", () => {
  assert.equal(severityFromScore(9), "critical");
  assert.equal(severityFromScore(8.9), "high");
  assert.equal(severityFromScore(7), "high");
  assert.equal(severityFromScore(6.9), "moderate");
  assert.equal(severityFromScore(0.1), "low");
  assert.equal(severityFromScore(0), "info");
});

// ---- classification -----------------------------------------------------------------

test("sensitive toolchain packages are recognised", () => {
  for (const name of ["@stellar/stellar-sdk", "@stellar/freighter-api", "@creit-tech/stellar-wallets-kit", "jsonwebtoken", "soroban-sdk", "soroban-env-host", "stellar-xdr", "ed25519-dalek", "curve25519-dalek", "sha2", "rand_core"]) {
    assert.ok(isSensitivePackage(name), name);
  }
  for (const name of ["react", "lodash", "semver", "sha2-extra", "random-words"]) assert.ok(!isSensitivePackage(name), name);
});

test("blocking policy: critical anywhere, high only for sensitive packages", () => {
  assert.ok(isBlocking(finding({ severity: "critical" })));
  assert.ok(isBlocking(finding({ severity: "high", sensitive: true })));
  assert.ok(!isBlocking(finding({ severity: "high" })));
  assert.ok(!isBlocking(finding({ severity: "moderate", sensitive: true })));
});

// ---- normalisation ------------------------------------------------------------------

test("normalizeNpmAudit extracts advisories and skips transitive pointers", () => {
  const findings = normalizeNpmAudit(fixture("npm-audit.json"), "backend");
  assert.deepEqual(findings.map((f) => [f.package, f.id, f.severity, f.sensitive]), [
    ["jsonwebtoken", "GHSA-8cf7-32gw-wr33", "high", true],
    ["semver", "GHSA-c2qf-rxjj-qqgw", "moderate", false],
  ]);
});

test("normalizePnpmAudit keeps GHSA as id and CVE as alias", () => {
  const [next] = normalizePnpmAudit(fixture("pnpm-audit.json"), "frontend");
  assert.equal(next.id, "GHSA-f82v-jwr5-mffw");
  assert.ok(next.aliases.includes("CVE-2025-29927"));
  assert.equal(next.severity, "critical");
});

test("normalizeCargoAudit derives severity from CVSS", () => {
  const findings = normalizeCargoAudit(fixture("cargo-audit.json"), "contract");
  assert.deepEqual(findings.map((f) => [f.package, f.severity, f.sensitive]), [
    ["ed25519-dalek", "high", true],
    ["some-parser", "moderate", false],
  ]);
});

test("normalisers reject reports of the wrong shape", () => {
  assert.throws(() => normalizeNpmAudit({ error: { code: "ENOLOCK" } }, "x"), /npm audit v2/);
  assert.throws(() => normalizePnpmAudit(null, "x"), /pnpm audit/);
  assert.throws(() => normalizeCargoAudit([], "x"), /cargo audit/);
});

test("dedupeFindings collapses the same advisory from several reports", () => {
  const out = dedupeFindings([finding({ source: "a" }), finding({ source: "b", severity: "high" })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "high");
  assert.equal(out[0].source, "a,b");
});

// ---- exceptions ---------------------------------------------------------------------

const exception = (overrides = {}) => ({ id: "GHSA-8cf7-32gw-wr33", ecosystem: "npm", package: "jsonwebtoken", reason: "not reachable", approvedBy: "@sec", expires: inDays(30), ...overrides });

test("validateExceptions sorts active, expired and invalid entries", () => {
  const result = validateExceptions({ version: 1, exceptions: [
    exception(),
    exception({ expires: inDays(-1) }),
    exception({ expires: inDays(MAX_EXCEPTION_DAYS + 1) }),
    exception({ reason: "" }),
    exception({ ecosystem: "pip" }),
    exception({ expires: "someday" }),
  ] }, NOW);
  assert.equal(result.active.length, 1);
  assert.equal(result.expired.length, 1);
  assert.equal(result.invalid.length, 4);
});

test("exception expiring exactly at the 90-day boundary is allowed", () => {
  const expires = new Date(NOW.getTime() + MAX_EXCEPTION_DAYS * 86400000).toISOString();
  assert.equal(validateExceptions({ version: 1, exceptions: [exception({ expires })] }, NOW).active.length, 1);
});

test("malformed exceptions file is invalid, never permissive", () => {
  assert.equal(validateExceptions({ exceptions: [] }, NOW).invalid.length, 1);
  assert.equal(validateExceptions(null, NOW).invalid.length, 1);
});

// ---- gate decision ------------------------------------------------------------------

test("gate blocks sensitive highs and criticals, reports the rest", () => {
  const findings = [
    ...normalizeNpmAudit(fixture("npm-audit.json"), "backend"),
    ...normalizePnpmAudit(fixture("pnpm-audit.json"), "frontend"),
    ...normalizeCargoAudit(fixture("cargo-audit.json"), "contract"),
  ];
  const result = evaluateGate(findings, noExceptions());
  assert.equal(result.pass, false);
  assert.deepEqual(result.blocked.map((f) => f.package).sort(), ["ed25519-dalek", "jsonwebtoken", "next"]);
  assert.equal(result.reported.length, 3);
});

test("an active exception suppresses exactly its advisory, also via alias", () => {
  const exceptions = validateExceptions({ version: 1, exceptions: [
    exception(),
    exception({ id: "CVE-2025-29927", package: "next" }),
    exception({ id: "RUSTSEC-2022-0093", ecosystem: "cargo", package: "ed25519-dalek" }),
    exception({ id: "GHSA-0000-0000-0000", package: "unused-pkg" }),
  ] }, NOW);
  const findings = [
    ...normalizeNpmAudit(fixture("npm-audit.json"), "backend"),
    ...normalizePnpmAudit(fixture("pnpm-audit.json"), "frontend"),
    ...normalizeCargoAudit(fixture("cargo-audit.json"), "contract"),
  ];
  const result = evaluateGate(findings, exceptions);
  assert.equal(result.pass, true);
  assert.equal(result.excepted.length, 3);
  assert.deepEqual(result.unused.map((e) => e.package), ["unused-pkg"]);
});

test("an exception for the right id but wrong package does not apply", () => {
  const exceptions = validateExceptions({ version: 1, exceptions: [exception({ package: "jws" })] }, NOW);
  const result = evaluateGate([finding({ id: "GHSA-8cf7-32gw-wr33", package: "jsonwebtoken", severity: "high", sensitive: true })], exceptions);
  assert.equal(result.pass, false);
});

test("an expired exception blocks again and is flagged on the finding", () => {
  const exceptions = validateExceptions({ version: 1, exceptions: [exception({ expires: inDays(-1) })] }, NOW);
  const result = evaluateGate(normalizeNpmAudit(fixture("npm-audit.json"), "backend"), exceptions);
  assert.equal(result.pass, false);
  assert.equal(result.blocked[0].expiredException, inDays(-1));
});

test("invalid exceptions or unavailable reports fail closed even with no findings", () => {
  assert.equal(evaluateGate([], validateExceptions({ version: 1, exceptions: [exception({ approvedBy: "" })] }, NOW)).pass, false);
  assert.equal(evaluateGate([], noExceptions(), ["frontend: timeout"]).pass, false);
  assert.equal(evaluateGate([], noExceptions()).pass, true);
});

// ---- CLI (integration) --------------------------------------------------------------

test("parseArgs validates usage", () => {
  assert.throws(() => parseArgs([]), /missing value|at least one report/);
  assert.throws(() => parseArgs(["--npm", "nopath"]), /source>=<path/);
  assert.throws(() => parseArgs(["--npm", "a=b"]), /--exceptions is required/);
  assert.throws(() => parseArgs(["--bogus", "x"]), /unknown flag/);
});

function workspace(exceptions) {
  const dir = mkdtempSync(join(tmpdir(), "dep-gate-"));
  const exceptionsPath = join(dir, "exceptions.json");
  writeFileSync(exceptionsPath, JSON.stringify(exceptions));
  return { dir, exceptionsPath };
}

test("runGate end-to-end writes summary + step summary", () => {
  const { dir, exceptionsPath } = workspace({ version: 1, exceptions: [] });
  const stepSummary = join(dir, "step.md");
  const summaryOut = join(dir, "summary.json");
  const result = runGate([
    "--npm", `backend=${join(here, "fixtures", "npm-audit.json")}`,
    "--pnpm", `frontend=${join(here, "fixtures", "pnpm-audit.json")}`,
    "--cargo", `contract=${join(here, "fixtures", "cargo-audit.json")}`,
    "--exceptions", exceptionsPath, "--summary-out", summaryOut, "--now", NOW.toISOString(),
  ], { GITHUB_STEP_SUMMARY: stepSummary });
  assert.equal(result.pass, false);
  assert.match(readFileSync(stepSummary, "utf8"), /Blocking advisories/);
  assert.equal(JSON.parse(readFileSync(summaryOut, "utf8")).blocked.length, 3);
});

test("CLI exit codes: 1 when blocked, 1 when a report is missing, 0 when clean, 2 on usage error", () => {
  const cli = join(here, "gate.mjs");
  const { dir, exceptionsPath } = workspace({ version: 1, exceptions: [] });
  const clean = join(dir, "clean.json");
  writeFileSync(clean, JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} }));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, "--exceptions", exceptionsPath], { encoding: "utf8", env: { PATH: process.env.PATH } });

  assert.equal(run("--npm", `backend=${join(here, "fixtures", "npm-audit.json")}`).status, 1);
  const missing = run("--npm", `backend=${join(dir, "nope.json")}`);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /dependency_gate_report_unavailable/);
  const ok = run("--npm", `backend=${clean}`);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /"event":"dependency_gate_result","pass":true/);
  assert.equal(spawnSync(process.execPath, [cli, "--npm"], { encoding: "utf8" }).status, 2);
});

test("report prefixed with tool warnings is still parsed (retry output noise)", () => {
  const { dir, exceptionsPath } = workspace({ version: 1, exceptions: [] });
  const noisy = join(dir, "noisy.json");
  writeFileSync(noisy, `npm warn config production Use --omit=dev instead.\n${JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} })}`);
  assert.equal(runGate(["--npm", `backend=${noisy}`, "--exceptions", exceptionsPath], {}).pass, true);
});
