#!/usr/bin/env tsx
/**
 * scripts/contract-manifest.ts
 *
 * Implements local contract deployment manifest generation and validation (#1462).
 * Validates network passphrase, contract IDs, WASM hashes, and ABI versions.
 */

import * as fs from "fs";
import * as path from "path";

export interface ContractEntry {
  id: string;
  wasmHash: string;
  abiVersion: string;
  methods: string[];
}

export interface ContractDeploymentManifest {
  schemaVersion: number;
  network: "testnet" | "mainnet" | "standalone";
  networkPassphrase: string;
  rpcUrl: string;
  deployedAt: string;
  gitCommit?: string;
  contracts: {
    arena: ContractEntry;
    factory: ContractEntry;
    payout: ContractEntry;
    staking: ContractEntry;
    [key: string]: ContractEntry;
  };
}

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export const NETWORK_PASSPHRASES: Record<string, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  standalone: "Standalone Network ; February 2017",
};

export const CONTRACT_ID_REGEX = /^C[A-Z2-7]{55}$/;
export const WASM_HASH_REGEX = /^[0-9a-fA-F]{64}$/;

export function validateManifest(data: unknown): ManifestValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!data || typeof data !== "object") {
    return { valid: false, errors: ["Manifest payload must be a non-null object"], warnings };
  }

  const m = data as Partial<ContractDeploymentManifest>;

  if (m.schemaVersion !== 1) {
    errors.push(`Unsupported or missing schemaVersion: expected 1, got ${m.schemaVersion}`);
  }

  if (!m.network || !["testnet", "mainnet", "standalone"].includes(m.network)) {
    errors.push(`Invalid network: expected 'testnet', 'mainnet', or 'standalone', got '${m.network}'`);
  } else {
    const expectedPassphrase = NETWORK_PASSPHRASES[m.network];
    if (m.networkPassphrase !== expectedPassphrase) {
      errors.push(
        `Network passphrase mismatch for ${m.network}: expected "${expectedPassphrase}", got "${m.networkPassphrase}"`
      );
    }
  }

  if (!m.rpcUrl || typeof m.rpcUrl !== "string") {
    errors.push("Missing or invalid rpcUrl");
  }

  if (!m.contracts || typeof m.contracts !== "object") {
    errors.push("Missing 'contracts' object in manifest");
    return { valid: false, errors, warnings };
  }

  const requiredContracts = ["arena", "factory", "payout", "staking"];
  for (const name of requiredContracts) {
    const c = m.contracts[name];
    if (!c) {
      errors.push(`Required contract missing from manifest: '${name}'`);
      continue;
    }

    if (!c.id || !CONTRACT_ID_REGEX.test(c.id)) {
      errors.push(`Contract '${name}' has invalid contract ID: '${c.id}'`);
    }

    if (!c.wasmHash || !WASM_HASH_REGEX.test(c.wasmHash)) {
      errors.push(`Contract '${name}' has invalid WASM hash: '${c.wasmHash}'`);
    }

    if (!c.abiVersion || typeof c.abiVersion !== "string") {
      errors.push(`Contract '${name}' missing valid abiVersion`);
    }

    if (!Array.isArray(c.methods) || c.methods.length === 0) {
      warnings.push(`Contract '${name}' has empty or missing methods array`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function generateManifest(params: {
  network: "testnet" | "mainnet" | "standalone";
  rpcUrl: string;
  contracts: Record<string, { id: string; wasmHash: string; abiVersion?: string; methods?: string[] }>;
  gitCommit?: string;
}): ContractDeploymentManifest {
  const passphrase = NETWORK_PASSPHRASES[params.network];
  if (!passphrase) {
    throw new Error(`Unknown network: ${params.network}`);
  }

  const defaultMethods: Record<string, string[]> = {
    arena: ["init", "join", "commit", "reveal", "close", "resolve", "settle"],
    factory: ["init", "create_pool", "get_arena", "upgrade"],
    payout: ["init", "distribute_winnings", "claim", "refund"],
    staking: ["init", "deposit", "withdraw", "get_stake"],
  };

  const formattedContracts: any = {};
  for (const [name, entry] of Object.entries(params.contracts)) {
    formattedContracts[name] = {
      id: entry.id,
      wasmHash: entry.wasmHash.toLowerCase(),
      abiVersion: entry.abiVersion || "1.0.0",
      methods: entry.methods || defaultMethods[name] || ["init"],
    };
  }

  return {
    schemaVersion: 1,
    network: params.network,
    networkPassphrase: passphrase,
    rpcUrl: params.rpcUrl,
    deployedAt: new Date().toISOString(),
    gitCommit: params.gitCommit || "local-dev",
    contracts: formattedContracts,
  };
}

if (process.argv[1] && process.argv[1].endsWith("contract-manifest.ts")) {
  const action = process.argv[2] || "validate";
  const filePath = process.argv[3] || path.resolve(process.cwd(), "contract/deployment-manifest.json");

  if (action === "validate") {
    if (!fs.existsSync(filePath)) {
      console.error(`Manifest file not found: ${filePath}`);
      process.exit(1);
    }
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const result = validateManifest(content);
    if (!result.valid) {
      console.error("❌ Manifest validation failed:");
      result.errors.forEach((e) => console.error(`  - ${e}`));
      process.exit(1);
    }
    console.log("✅ Contract deployment manifest is valid.");
    if (result.warnings.length > 0) {
      result.warnings.forEach((w) => console.warn(`  ⚠️ ${w}`));
    }
  }
}
