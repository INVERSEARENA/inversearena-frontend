#!/usr/bin/env node
/**
 * Lints backend code to ensure no direct process.env reads occur outside backend/src/config (#1650).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backendSrcDir = resolve(root, "backend/src");
const configDir = resolve(backendSrcDir, "config");

function getFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry !== "node_modules" && entry !== "dist") {
        files.push(...getFiles(fullPath));
      }
    } else if (/\.(ts|js|mjs)$/.test(entry)) {
      files.push(fullPath);
    }
  }
  return files;
}

const allFiles = getFiles(backendSrcDir);
const violations = [];

for (const file of allFiles) {
  // Allow config directory files to read process.env
  if (file.startsWith(configDir)) continue;

  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Check for process.env usage that is not in a comment
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    if (/\bprocess\.env\b/.test(line)) {
      violations.push({
        file: relative(root, file).replace(/\\/g, "/"),
        line: i + 1,
        code: trimmed,
      });
    }
  }
}

if (violations.length > 0) {
  console.error("❌ Direct process.env reads detected outside backend/src/config:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} -> ${v.code}`);
  }
  console.error(
    '\nDirect process.env reads are banned outside backend/src/config. Import "config" from "@/config" or "./config".\n'
  );
  process.exit(1);
} else {
  console.log("✅ Zero direct process.env reads outside backend/src/config.");
  process.exit(0);
}
