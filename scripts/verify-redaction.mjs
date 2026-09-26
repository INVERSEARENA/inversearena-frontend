#!/usr/bin/env node
/**
 * CI guard for secret redaction regressions (#1531).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const redactionPath = resolve(
  root,
  "frontend/src/shared-d/security/redaction.ts",
);
const source = readFileSync(redactionPath, "utf8");

const samples = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
  "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAgAAAAD",
];

if (!source.includes("redactSecrets")) {
  console.error("redaction module missing redactSecrets export");
  process.exit(1);
}

for (const sample of samples) {
  if (source.includes(sample)) {
    console.error("redaction source must not embed raw secret samples");
    process.exit(1);
  }
}

console.log(JSON.stringify({ ok: true, checked: samples.length }));
