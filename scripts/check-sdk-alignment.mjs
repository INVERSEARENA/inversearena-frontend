#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const targets = [
  "frontend/package.json",
  "backend/package.json",
  "scripts/package.json",
  "tools/ops-cli/package.json",
];
const majors = new Map();
for (const rel of targets) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) continue;
  const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
  const spec =
    pkg.dependencies?.["@stellar/stellar-sdk"] ??
    pkg.devDependencies?.["@stellar/stellar-sdk"];
  if (!spec) continue;
  const m = String(spec).match(/(\d+)/);
  if (!m) throw new Error(`${rel}: cannot parse @stellar/stellar-sdk spec ${spec}`);
  majors.set(rel, { spec, major: m[1] });
}
const values = [...new Set([...majors.values()].map((v) => v.major))];
if (values.length !== 1) {
  console.error("Stellar SDK major version mismatch across workspace:");
  for (const [rel, v] of majors) console.error(`  ${rel}: ${v.spec} (major ${v.major})`);
  process.exit(1);
}
console.log(`@stellar/stellar-sdk major aligned: ${values[0]}`);
