#!/usr/bin/env node
/**
 * Generates frontend/.env.example and backend/.env.example from their typed Zod schemas (#1650).
 * Supports --check flag in CI to fail if committed .env.example files have drifted from schemas.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontendEnvExamplePath = resolve(root, "frontend/.env.example");
const backendEnvExamplePath = resolve(root, "backend/.env.example");

// ── Frontend Definition ──────────────────────────────────────────────────────
const frontendSections = [
  {
    title: "Stellar / Soroban",
    vars: [
      {
        name: "NEXT_PUBLIC_STELLAR_NETWORK",
        default: "testnet",
        comment: '"testnet" or "mainnet" (defaults to testnet)',
      },
      {
        name: "NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE",
        default: "",
        comment: "Custom Stellar network passphrase; defaults to public or testnet passphrase",
      },
      {
        name: "NEXT_PUBLIC_SOROBAN_RPC_URL",
        default: "",
        comment: "Soroban RPC endpoint URL",
      },
      {
        name: "NEXT_PUBLIC_HORIZON_URL",
        default: "",
        comment: "Horizon API endpoint URL",
      },
      {
        name: "NEXT_PUBLIC_FACTORY_CONTRACT_ID",
        default: "",
        comment: "Stellar contract ID for Arena Factory contract",
      },
      {
        name: "NEXT_PUBLIC_USDC_CONTRACT_ID",
        default: "",
        comment: "Soroban token contract ID for USDC",
      },
      {
        name: "NEXT_PUBLIC_XLM_CONTRACT_ID",
        default: "",
        comment: "Soroban contract ID for native XLM token wrapper (optional)",
      },
      {
        name: "NEXT_PUBLIC_STAKING_CONTRACT_ID",
        default: "",
        comment: "Stellar contract ID for Staking contract (optional)",
      },
      {
        name: "NEXT_PUBLIC_RWA_VAULT_CONTRACT_ID",
        default: "",
        comment: "Stellar contract ID for RWA Vault contract (optional)",
      },
      {
        name: "NEXT_PUBLIC_ORACLE_CONTRACT_ID",
        default: "",
        comment: "Stellar contract ID for Oracle contract (optional)",
      },
      {
        name: "NEXT_PUBLIC_APP_ORIGIN",
        default: "",
        comment: "Canonical frontend application origin URL",
      },
      {
        name: "NEXT_PUBLIC_CONTRACT_MANIFEST_PATH",
        default: "contract/deployment-manifest.json",
        comment: "Optional path to local contract deployment manifest (#1462)",
      },
    ],
  },
  {
    title: "Classic asset issuers (#1487)",
    headerDocs: [
      "# A `changeTrust` is keyed by the exact (code, issuer) pair, so a stake or",
      "# payout in a credit asset cannot be settled without its issuer. These are the",
      "# issuers for the *classic* path; they are separate from the Soroban token",
      "# contract ids above, and the same asset has two distinct identifiers on",
      "# Stellar. The app never guesses an issuer: an unset value blocks every",
      "# action denominated in that asset with a message naming the variable to set,",
      "# rather than defaulting to something that would create a trustline the user",
      "# does not hold.",
      "#",
      "# XLM needs none of this — it is the native asset and has no trustline.",
    ],
    vars: [
      {
        name: "NEXT_PUBLIC_USDC_ISSUER",
        default: "",
        comment: "Classic credit-asset issuer public key (G...) for USDC",
      },
      {
        name: "NEXT_PUBLIC_EURC_ISSUER",
        default: "",
        comment: "Classic credit-asset issuer public key (G...) for EURC",
      },
    ],
  },
  {
    title: "Arena",
    headerDocs: [
      "# Stellar contract address of the arena to display on /arena (C + 55 base-32 chars).",
      "# When unset the arena page falls back to static demo data instead of live on-chain state.",
    ],
    vars: [
      {
        name: "NEXT_PUBLIC_DEMO_ARENA_ID",
        default: "",
        comment: "Stellar contract address of the demo arena to display on /arena",
      },
    ],
  },
  {
    title: "Backend API & Dev Toggles",
    vars: [
      {
        name: "NEXT_PUBLIC_API_BASE_URL",
        default: "",
        comment: "Base URL for backend API calls (defaults to http://localhost:4000)",
      },
      {
        name: "NEXT_PUBLIC_USE_MOCK_PROFILE",
        default: "",
        comment: "Toggle mock profile data in development ('true' or 'false')",
      },
      {
        name: "NEXT_PUBLIC_PASSKEY_DEMO_MODE",
        default: "",
        comment: "Toggle passkey demo mode in development ('true' or 'false')",
      },
      {
        name: "NEXT_PUBLIC_TELEMETRY_POLL_INTERVAL_MS",
        default: "",
        comment: "Telemetry polling interval in milliseconds",
      },
    ],
  },
  {
    title: "CORS",
    vars: [
      {
        name: "ALLOWED_ORIGINS",
        default: "",
        comment: "Comma-separated list of allowed CORS origins for API routes",
      },
    ],
  },
  {
    title: "Redis (rate limiting)",
    headerDocs: [
      "# Required for a shared global rate limit across instances. When unset, the",
      "# limiter falls back to per-process in-memory counting (effective limit becomes",
      "# points × instance_count) and logs a startup warning.",
    ],
    vars: [
      {
        name: "REDIS_URL",
        default: "",
        comment: "Redis connection URL for distributed rate limiting",
      },
      {
        name: "TRUSTED_PROXY_COUNT",
        default: "0",
        comment: "Number of trusted reverse proxies (CDN / load balancer) in front of the app",
      },
    ],
  },
  {
    title: "Sentry (error reporting)",
    headerDocs: [
      "# Obtain your DSN from https://sentry.io → Settings → Projects → Client Keys.",
      "# Leave blank to disable error reporting (safe for local development).",
    ],
    vars: [
      {
        name: "NEXT_PUBLIC_SENTRY_DSN",
        default: "",
        comment: "Sentry DSN for client and server error reporting",
      },
      {
        name: "NEXT_PUBLIC_SENTRY_ENVIRONMENT",
        default: "",
        comment: "Optional: label events by environment (defaults to NODE_ENV)",
      },
      {
        name: "NEXT_PUBLIC_SENTRY_RELEASE",
        default: "",
        comment: "Optional: set by CI to git SHA or semver tag for release tracking",
      },
      {
        name: "SENTRY_AUTH_TOKEN",
        default: "",
        comment: "Server-only: Sentry auth token for uploading source maps during build",
      },
    ],
  },
];

// ── Backend Definition ───────────────────────────────────────────────────────
const backendSections = [
  {
    title: "Server",
    vars: [
      { name: "PORT", default: "3001", comment: "HTTP server port" },
      { name: "NODE_ENV", default: "development", comment: "'development', 'production', or 'test'" },
      { name: "LOG_LEVEL", default: "info", comment: "Pino log level ('info', 'debug', 'warn', etc.)" },
    ],
  },
  {
    title: "Database",
    vars: [
      {
        name: "DATABASE_URL",
        default: "postgresql://postgres:postgres@localhost:5432/inversearena?schema=public",
        comment: "PostgreSQL connection string (Prisma)",
      },
    ],
  },
  {
    title: "MongoDB",
    vars: [
      {
        name: "MONGODB_URI",
        default: "mongodb://localhost:27017/inversearena",
        comment: "MongoDB connection string for off-chain transactional records",
      },
    ],
  },
  {
    title: "Admin auth",
    headerDocs: [
      "# Must be ≥32 characters (enforced at startup) to resist timing attacks",
      "# ⚠️ Change this from the default value before deploying",
    ],
    vars: [
      {
        name: "ADMIN_API_KEY",
        default: "change-me-in-production",
        comment: "Admin API key for privileged operations (minimum 32 characters)",
      },
      {
        name: "ADMIN_TOKEN_TTL_SECONDS",
        default: "900",
        comment: "Admin confirmation token TTL in seconds. Minimum 300 (or 0 for API key auth only)",
      },
      {
        name: "ADMIN_WALLET_ADDRESSES",
        default: "",
        comment: "Comma-separated Stellar public keys authorized to manage arenas",
      },
    ],
  },
  {
    title: "Wallet auth (JWT)",
    headerDocs: [
      "# Rotation (#1456, docs/design/secret-rotation.md): during an overlap window the",
      "# previous secret is verify-only until the expiry (ISO-8601, at most 30 days).",
      "# JWT_SECRET_KID=",
      "# JWT_SECRET_PREVIOUS=",
      "# JWT_SECRET_PREVIOUS_KID=",
      "# JWT_SECRET_PREVIOUS_EXPIRES_AT=2026-01-08T00:00:00Z",
    ],
    vars: [
      {
        name: "JWT_SECRET",
        default: "change-me-minimum-32-characters-long",
        comment: "JWT signing secret (minimum 32 characters)",
      },
      { name: "JWT_EXPIRES_IN", default: "15m", comment: "Access token lifetime" },
      { name: "JWT_REFRESH_EXPIRES_IN", default: "7d", comment: "Refresh token lifetime" },
      { name: "NONCE_TTL_SECONDS", default: "300", comment: "Wallet auth challenge nonce TTL" },
    ],
  },
  {
    title: "Soroban / Stellar",
    vars: [
      {
        name: "SOROBAN_RPC_URL",
        default: "https://soroban-testnet.stellar.org",
        comment: "Soroban RPC endpoint",
      },
      {
        name: "STELLAR_NETWORK_PASSPHRASE",
        default: "Test SDF Network ; September 2015",
        comment: "Stellar network passphrase",
      },
      {
        name: "PAYOUT_CONTRACT_ID",
        default: "C...",
        comment: "Contract ID for payout distribution",
      },
      {
        name: "PAYOUT_SOURCE_ACCOUNT",
        default: "G...",
        comment: "Stellar account ID for payout transaction source account",
      },
      {
        name: "ARENA_FACTORY_CONTRACT_ID",
        default: "C...",
        comment: "Contract ID for Arena Factory contract",
      },
      {
        name: "PAYOUT_METHOD_NAME",
        default: "distribute_winnings",
        comment: "Contract method name invoked for payouts",
      },
      {
        name: "CONTRACT_MANIFEST_PATH",
        default: "../contract/deployment-manifest.json",
        comment: "Optional: path to local contract deployment manifest (#1462)",
      },
    ],
  },
  {
    title: "Oracle webhook",
    headerDocs: [
      "# Same rotation contract as JWT. Senders may name the key via `x-oracle-key-id`.",
      "# ORACLE_WEBHOOK_SECRET_KID=",
      "# ORACLE_WEBHOOK_SECRET_PREVIOUS=",
      "# ORACLE_WEBHOOK_SECRET_PREVIOUS_KID=",
      "# ORACLE_WEBHOOK_SECRET_PREVIOUS_EXPIRES_AT=",
    ],
    vars: [
      {
        name: "ORACLE_WEBHOOK_SECRET",
        default: "change-me-in-production",
        comment: "Shared secret for Oracle webhook verification",
      },
    ],
  },
  {
    title: "Redis",
    vars: [
      {
        name: "REDIS_URL",
        default: "redis://localhost:6379",
        comment: "Redis connection URL",
      },
    ],
  },
  {
    title: "Rate limiting (defaults shown)",
    headerDocs: [
      "# RATE_LIMIT_NONCE_PREFIX=rl:auth:nonce",
      "# RATE_LIMIT_NONCE_POINTS=5",
      "# RATE_LIMIT_NONCE_WINDOW_SECONDS=60",
      "# RATE_LIMIT_VERIFY_PREFIX=rl:auth:verify",
      "# RATE_LIMIT_VERIFY_POINTS=10",
      "# RATE_LIMIT_VERIFY_WINDOW_SECONDS=60",
      "# RATE_LIMIT_REFRESH_PREFIX=rl:auth:refresh",
      "# RATE_LIMIT_REFRESH_POINTS=20",
      "# RATE_LIMIT_REFRESH_WINDOW_SECONDS=60",
      "# RATE_LIMIT_POOLS_PREFIX=rl:pools:create",
      "# RATE_LIMIT_POOLS_POINTS=3",
      "# RATE_LIMIT_POOLS_WINDOW_SECONDS=60",
      "# SSE_MAX_CONNECTIONS_PER_IP=5",
      "# SSE_MAX_CONNECTIONS_PER_ARENA=100",
    ],
    vars: [],
  },
  {
    title: "Payout execution flags",
    vars: [
      { name: "PAYOUTS_LIVE_EXECUTION", default: "false", comment: "Enable live on-chain payouts" },
      { name: "PAYOUTS_SIGN_WITH_HOT_KEY", default: "false", comment: "Sign with hot key" },
    ],
  },
  {
    title: "Payout worker tuning",
    headerDocs: [
      "# Optional: only set in controlled environments",
      "# PAYOUT_HOT_SIGNER_SECRET=S...",
    ],
    vars: [
      { name: "PAYOUTS_MAX_GAS_STROOPS", default: "2000000", comment: "Max gas stroops" },
      { name: "PAYOUTS_MAX_ATTEMPTS", default: "5", comment: "Max transaction attempts" },
      { name: "PAYOUTS_CONFIRM_POLL_MS", default: "2500", comment: "Confirmation poll interval" },
      { name: "PAYOUTS_CONFIRM_MAX_POLLS", default: "20", comment: "Max confirmation polls" },
      { name: "PAYOUTS_FAILED_RETRY_MAX", default: "3", comment: "Retry count for failed payouts" },
      { name: "PAYOUTS_FAILED_RETRY_BASE_MS", default: "5000", comment: "Base retry backoff in ms" },
      { name: "TX_WORKER_CONCURRENCY", default: "1", comment: "Worker concurrency" },
    ],
  },
  {
    title: "resolveRound on-chain confirmation polling (#1193)",
    vars: [
      { name: "ROUND_CONFIRM_POLL_MS", default: "2500", comment: "Base delay between polls in ms" },
      { name: "ROUND_CONFIRM_MAX_POLLS", default: "20", comment: "Maximum number of polls before giving up" },
    ],
  },
  {
    title: "Settlement receipts (#1407)",
    headerDocs: [
      "# Basis points (0-10000) of a round's yield portion withheld as a platform",
      "# fee when computing the settlement breakdown (principal/yield/fee/dust).",
      "# Defaults to 0 (all yield paid to the winner, backwards compatible).",
    ],
    vars: [
      { name: "PLATFORM_FEE_BPS", default: "0", comment: "Platform fee in basis points" },
    ],
  },
];

function generateContent(sections) {
  const lines = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (i > 0) lines.push("");

    lines.push(`# ── ${section.title} ${"─".repeat(Math.max(2, 70 - section.title.length))}`);

    if (section.headerDocs) {
      for (const doc of section.headerDocs) {
        lines.push(doc);
      }
    }

    for (const v of section.vars) {
      const assignment = `${v.name}=${v.default}`;
      if (v.comment) {
        // Pad for neat alignment
        const padding = " ".repeat(Math.max(1, 46 - assignment.length));
        lines.push(`${assignment}${padding}# ${v.comment}`);
      } else {
        lines.push(assignment);
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

const isCheck = process.argv.includes("--check");

const frontendContent = generateContent(frontendSections);
const backendContent = generateContent(backendSections);

if (isCheck) {
  let hasDrift = false;

  const currentFrontend = readFileSync(frontendEnvExamplePath, "utf8").replace(/\r\n/g, "\n");
  const normalizedFrontend = frontendContent.replace(/\r\n/g, "\n");
  if (currentFrontend !== normalizedFrontend) {
    console.error("❌ frontend/.env.example is out of sync with schemas!");
    hasDrift = true;
  }

  const currentBackend = readFileSync(backendEnvExamplePath, "utf8").replace(/\r\n/g, "\n");
  const normalizedBackend = backendContent.replace(/\r\n/g, "\n");
  if (currentBackend !== normalizedBackend) {
    console.error("❌ backend/.env.example is out of sync with schemas!");
    hasDrift = true;
  }

  if (hasDrift) {
    console.error('\nRun "node scripts/generate-env-examples.mjs" to regenerate .env.example files.\n');
    process.exit(1);
  }

  console.log("✅ All .env.example files are up to date with environment schemas.");
  process.exit(0);
} else {
  writeFileSync(frontendEnvExamplePath, frontendContent, "utf8");
  writeFileSync(backendEnvExamplePath, backendContent, "utf8");
  console.log("✅ Successfully generated frontend/.env.example and backend/.env.example");
}
