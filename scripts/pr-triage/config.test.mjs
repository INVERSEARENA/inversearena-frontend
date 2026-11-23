import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("pr-triage config loads and has required fields", () => {
  const cfg = loadConfig(fs.readFileSync(path.join(ROOT, ".github/pr-triage.json"), "utf8"));
  assert.ok(Date.parse(cfg.enforceAfter));
  assert.ok(cfg.botAllowlist.includes("dependabot[bot]"));
  assert.equal(cfg.duplicateLabel, "duplicate");
  assert.equal(typeof cfg.maxPrsScanned, "number");
});

test("labeler uses existing labels only", () => {
  const allowed = new Set([
    "integration","contracts","smart-contract","soroban","frontend","documentation","devx","ci","tests","testing",
  ]);
  const labeler = fs.readFileSync(path.join(ROOT, ".github/labeler.yml"), "utf8");
  for (const m of labeler.matchAll(/^([A-Za-z0-9_-]+):/gm)) {
    assert.ok(allowed.has(m[1]), `unexpected label ${m[1]}`);
  }
  assert.doesNotMatch(labeler, /\bbackend\b:/);
  assert.doesNotMatch(labeler, /contracts\//); // no obsolete contracts/ path
});

test("CODEOWNERS has global fallback and area rules", () => {
  const c = fs.readFileSync(path.join(ROOT, ".github/CODEOWNERS"), "utf8");
  assert.match(c, /^\* @INVERSEARENA\/maintainers/m);
  for (const area of ["/contract/", "/backend/", "/frontend/", "/tools/", "/scripts/", "/packages/", "/docs/", "/.github/"]) {
    assert.match(c, new RegExp(`^\\${area} @INVERSEARENA/maintainers`, "m"));
  }
  assert.doesNotMatch(c, /@(?!INVERSEARENA\/maintainers)[A-Za-z0-9_-]+\//);
});
