#!/usr/bin/env node
/**
 * contract/scripts/check-abi-compatibility.mjs
 *
 * Verifies Soroban contract ABI snapshot files (`contract/<name>/abi_snapshot.json`)
 * and optionally runs `generate_abi_snapshots.sh --check` when compiled WASM
 * artifacts and the Stellar/Soroban CLI are available (#1465).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONTRACTS = ["arena", "factory", "payout", "staking"];
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024; // 2 MiB guard

export function checkAbiSnapshots({
  contractDir = CONTRACT_DIR,
  contracts = DEFAULT_CONTRACTS,
  requireWasm = false,
} = {}) {
  const errors = [];
  const warnings = [];
  const checked = [];

  for (const name of contracts) {
    const snapshotPath = join(contractDir, name, "abi_snapshot.json");
    if (!existsSync(snapshotPath)) {
      errors.push(`Missing ABI snapshot: ${name}/abi_snapshot.json`);
      continue;
    }

    const stat = statSync(snapshotPath);
    if (stat.size === 0 || stat.size > MAX_SNAPSHOT_BYTES) {
      errors.push(`Invalid ABI snapshot size for ${name}: ${stat.size} bytes`);
      continue;
    }

    try {
      const parsed = JSON.parse(readFileSync(snapshotPath, "utf8"));
      if (!Array.isArray(parsed)) {
        errors.push(`ABI snapshot ${name}/abi_snapshot.json must be a JSON array`);
        continue;
      }
      if (parsed.length === 0) {
        if (requireWasm) {
          errors.push(`ABI snapshot ${name}/abi_snapshot.json is empty`);
          continue;
        }
        warnings.push(`ABI snapshot ${name}/abi_snapshot.json is empty placeholder`);
      }
      checked.push({ contract: name, entries: parsed.length });
    } catch (err) {
      errors.push(
        `Malformed JSON in ${name}/abi_snapshot.json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const wasmExists =
    existsSync(join(contractDir, "target/wasm32v1-none/release")) ||
    existsSync(join(contractDir, "target/wasm32-unknown-unknown/release"));

  if (wasmExists) {
    try {
      execFileSync("bash", [join(contractDir, "scripts/generate_abi_snapshots.sh"), "--check"], {
        cwd: contractDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const stderr = err?.stderr ? String(err.stderr).trim() : "";
      if (stderr.includes("neither 'stellar' nor 'soroban' CLI found") && !requireWasm) {
        warnings.push("Stellar/Soroban CLI not installed; skipped live WASM ABI comparison");
      } else {
        errors.push(`WASM ABI snapshot check failed: ${stderr || (err instanceof Error ? err.message : String(err))}`);
      }
    }
  } else if (requireWasm) {
    errors.push("Compiled WASM artifacts not found under contract/target; run 'make contracts-build'");
  } else {
    warnings.push("Compiled WASM artifacts not present; validated committed ABI snapshots only");
  }

  return {
    ok: errors.length === 0,
    checked,
    errors,
    warnings,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requireWasm = process.argv.includes("--require-wasm");
  const result = checkAbiSnapshots({ requireWasm });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
