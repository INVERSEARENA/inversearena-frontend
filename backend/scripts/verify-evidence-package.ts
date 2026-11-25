#!/usr/bin/env tsx
/**
 * Support-facing verifier for player dispute evidence packages (#1517).
 *
 * Offline integrity check only: recomputes the package's checksum and checks
 * its schema version. Requires no database connection, no Soroban RPC access
 * and no production credentials — see backend/docs/DISPUTE_EVIDENCE_RUNBOOK.md
 * for how this fits into a support investigation.
 *
 * Usage:
 *   npm run verify:evidence -- --file /path/to/evidence-package.json
 *   npx tsx scripts/verify-evidence-package.ts --file package.json
 */

import { readFileSync } from "node:fs";
import { program } from "commander";
import { verifyEvidencePackage } from "../src/utils/evidenceChecksum";

program
  .requiredOption("--file <path>", "Path to the evidence package JSON file the player provided")
  .parse(process.argv);

const { file } = program.opts<{ file: string }>();

let raw: string;
try {
  raw = readFileSync(file, "utf-8");
} catch (error) {
  console.error(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

let candidate: unknown;
try {
  candidate = JSON.parse(raw);
} catch (error) {
  console.error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const result = verifyEvidencePackage(candidate);

if (result.valid) {
  console.log(`PASS — checksum and schema version (${result.schemaVersion}) verify.`);
  process.exit(0);
}

console.error(`FAIL — ${result.reason}: ${result.detail ?? "no further detail"}`);
process.exit(1);
