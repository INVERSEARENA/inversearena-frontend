#!/usr/bin/env tsx
/**
 * Stellar testnet account setup for new contributors.
 *
 * Creates four funded Stellar testnet accounts (admin, payout source, two
 * test players), writes their keys to .env.test in the repo root, and prints
 * clear instructions on next steps.
 *
 * WARNING: .env.test contains private keys.  It is listed in .gitignore and
 *          must NEVER be committed.
 *
 * Usage (from repo root):
 *   npx tsx scripts/setup-testnet.ts
 *   # or after npm install in scripts/:
 *   npm run setup-testnet
 *
 * Requirements:
 *   - Node 20+
 *   - Internet access to https://friendbot.stellar.org
 *   - No additional npm dependencies beyond @stellar/stellar-sdk (already a
 *     backend dep); the script uses the package installed in backend/.
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// Re-use the Stellar SDK already installed in the backend workspace.
// If running from the repo root, resolve via backend/node_modules.
let Keypair: typeof import("@stellar/stellar-sdk").Keypair;
let Networks: typeof import("@stellar/stellar-sdk").Networks;

try {
  const sdk = await import("@stellar/stellar-sdk");
  Keypair = sdk.Keypair;
  Networks = sdk.Networks;
} catch {
  // Fallback: resolve from backend node_modules
  const sdkPath = path.resolve(__dirname, "../backend/node_modules/@stellar/stellar-sdk");
  const sdk = await import(sdkPath);
  Keypair = sdk.Keypair;
  Networks = sdk.Networks;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestnetAccount {
  label: string;
  envKeySecret: string;
  envKeyPublic: string;
  keypair: InstanceType<typeof Keypair>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FRIENDBOT_URL = "https://friendbot.stellar.org";
const ENV_TEST_PATH = path.resolve(process.cwd(), ".env.test");

async function fundViaStellarFriendbot(publicKey: string): Promise<void> {
  const url = `${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`;
  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Friendbot returned ${res.status} for ${publicKey}: ${body}`
    );
  }
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function warningBanner(): void {
  const line = "!".repeat(60);
  console.log(`\n${line}`);
  console.log("  WARNING: PRIVATE KEYS WILL BE WRITTEN TO .env.test");
  console.log("  .env.test is in .gitignore — NEVER COMMIT THIS FILE.");
  console.log("  Use these accounts on TESTNET ONLY.");
  console.log(`${line}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== InverseArena — Stellar Testnet Account Setup ===\n");

  warningBanner();

  if (fs.existsSync(ENV_TEST_PATH)) {
    const answer = await prompt(
      `.env.test already exists at ${ENV_TEST_PATH}.\nOverwrite? (y/N): `
    );
    if (answer.toLowerCase() !== "y") {
      console.log("Aborted. Existing .env.test was not modified.");
      process.exit(0);
    }
  }

  const accounts: TestnetAccount[] = [
    {
      label: "Admin",
      envKeySecret: "ADMIN_ACCOUNT_SECRET",
      envKeyPublic: "ADMIN_ACCOUNT_PUBLIC",
      keypair: Keypair.random(),
    },
    {
      label: "Payout source",
      envKeySecret: "PAYOUT_SOURCE_SECRET",
      envKeyPublic: "PAYOUT_SOURCE_ACCOUNT",
      keypair: Keypair.random(),
    },
    {
      label: "Test player 1",
      envKeySecret: "TEST_PLAYER_1_SECRET",
      envKeyPublic: "TEST_PLAYER_1_PUBLIC",
      keypair: Keypair.random(),
    },
    {
      label: "Test player 2",
      envKeySecret: "TEST_PLAYER_2_SECRET",
      envKeyPublic: "TEST_PLAYER_2_PUBLIC",
      keypair: Keypair.random(),
    },
  ];

  console.log(`Creating and funding ${accounts.length} testnet accounts...\n`);

  const failed: string[] = [];

  for (const account of accounts) {
    process.stdout.write(`  Funding ${account.label} (${account.keypair.publicKey()})... `);
    try {
      await fundViaStellarFriendbot(account.keypair.publicKey());
      console.log("✓");
    } catch (err) {
      console.log("✗");
      console.error(`    Error: ${err instanceof Error ? err.message : err}`);
      failed.push(account.label);
    }
  }

  if (failed.length > 0) {
    console.warn(
      `\nWarning: funding failed for: ${failed.join(", ")}.\n` +
        `The Stellar Friendbot may be rate-limited — retry in a few seconds.\n`
    );
  }

  // Build .env.test content
  const lines: string[] = [
    "# Stellar testnet accounts — generated by scripts/setup-testnet.ts",
    "# WARNING: This file contains private keys. NEVER commit it.",
    "# Use on TESTNET only.",
    "",
    `STELLAR_NETWORK=testnet`,
    `STELLAR_NETWORK_PASSPHRASE="${Networks.TESTNET}"`,
    `SOROBAN_RPC_URL=https://soroban-testnet.stellar.org`,
    `HORIZON_URL=https://horizon-testnet.stellar.org`,
    "",
  ];

  for (const account of accounts) {
    lines.push(`# ${account.label}`);
    lines.push(`${account.envKeySecret}=${account.keypair.secret()}`);
    lines.push(`${account.envKeyPublic}=${account.keypair.publicKey()}`);
    lines.push("");
  }

  lines.push(
    "# Contract IDs — fill in after running: make contracts-deploy NETWORK=testnet"
  );
  lines.push("FACTORY_CONTRACT_ID=");
  lines.push("ARENA_CONTRACT_ID=");
  lines.push("PAYOUT_CONTRACT_ID=");
  lines.push("STAKING_CONTRACT_ID=");
  lines.push("");
  lines.push("# Backend");
  lines.push("DATABASE_URL=postgresql://localhost:5432/inversearena_test");
  lines.push("ADMIN_API_KEY=local-dev-admin-key-change-me");

  fs.writeFileSync(ENV_TEST_PATH, lines.join("\n") + "\n", { mode: 0o600 });

  console.log(`\nAccount details written to: ${ENV_TEST_PATH}`);
  console.log("File permissions set to 600 (owner read/write only).\n");

  // Print summary
  console.log("Account summary:");
  console.log("─".repeat(80));
  for (const account of accounts) {
    console.log(`  ${account.label.padEnd(16)} ${account.keypair.publicKey()}`);
  }
  console.log("─".repeat(80));

  console.log("\nNext steps:");
  console.log("  1. Deploy contracts:  make contracts-deploy NETWORK=testnet");
  console.log("  2. Copy contract IDs into .env.test (FACTORY_CONTRACT_ID, etc.)");
  console.log("  3. Copy backend vars into backend/.env");
  console.log("  4. Start the stack:   make backend-dev   &&   make frontend-dev");
  console.log("  5. Run simulation:    cd backend && npm run simulate -- --players 4");
  console.log("\nStellar Testnet explorer: https://stellar.expert/explorer/testnet\n");
}

main().catch((err) => {
  console.error("Setup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
