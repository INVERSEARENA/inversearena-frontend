import { z } from "zod";

const CONTRACT_ID_REGEX = /^C[A-Z2-7]{55}$/;
const ACCOUNT_ID_REGEX = /^G[A-Z2-7]{55}$/;
const SECRET_SEED_REGEX = /^S[A-Z2-7]{55}$/;

/**
 * Complete Zod schema for backend environment variables.
 * Each property has a .describe(...) string for automated .env.example documentation.
 */
export const backendEnvSchema = z.object({
  // ── Server & Process ──────────────────────────────────────────────────────
  PORT: z
    .string()
    .trim()
    .regex(/^\d+$/, "PORT must be an integer")
    .transform(Number)
    .default("3001")
    .describe("HTTP server listening port"),

  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development")
    .describe("Application runtime environment ('development', 'production', or 'test')"),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info")
    .describe("Pino logging level"),

  SENTRY_DSN: z
    .string()
    .trim()
    .url()
    .or(z.literal(""))
    .optional()
    .describe("Sentry DSN for backend exception and performance telemetry"),

  ALLOWED_ORIGINS: z
    .string()
    .trim()
    .default("")
    .describe("Comma-separated list of allowed CORS origins"),

  TTL_KEEPER_MANIFESTS: z
    .string()
    .trim()
    .optional()
    .describe("Comma-separated paths or JSON for TTL keeper contract manifests"),

  // ── Databases ─────────────────────────────────────────────────────────────
  DATABASE_URL: z
    .string()
    .trim()
    .describe("PostgreSQL connection string (Prisma)"),

  MONGODB_URI: z
    .string()
    .trim()
    .optional()
    .describe("MongoDB connection string for off-chain transactional records"),

  MONGO_URI: z
    .string()
    .trim()
    .optional()
    .describe("Alternative MongoDB connection string (alias for MONGODB_URI)"),

  REDIS_URL: z
    .string()
    .trim()
    .default("redis://localhost:6379")
    .describe("Redis connection URL for queue workers and rate limiting"),

  // ── Admin Authentication ──────────────────────────────────────────────────
  ADMIN_API_KEY: z
    .string()
    .trim()
    .min(32, "ADMIN_API_KEY must be at least 32 characters to resist brute-force and timing attacks")
    .describe("Admin API key for privileged operations (minimum 32 characters)"),

  ADMIN_TOKEN_TTL_SECONDS: z
    .string()
    .trim()
    .default("900")
    .transform(Number)
    .pipe(z.number().min(0, "ADMIN_TOKEN_TTL_SECONDS must be >= 0"))
    .describe("Admin confirmation token TTL in seconds (min 300, or 0 for API key auth only)"),

  ADMIN_WALLET_ADDRESSES: z
    .string()
    .trim()
    .optional()
    .describe("Comma-separated Stellar public keys authorized as admin role"),

  // ── Wallet Authentication (JWT) ───────────────────────────────────────────
  JWT_SECRET: z
    .string()
    .trim()
    .min(32, "JWT_SECRET must be at least 32 characters long")
    .describe("JWT signing secret (minimum 32 characters)"),

  JWT_SECRET_KID: z
    .string()
    .trim()
    .optional()
    .describe("Active JWT key ID for rotation"),

  JWT_SECRET_PREVIOUS: z
    .string()
    .trim()
    .optional()
    .describe("Previous JWT secret during key rotation window"),

  JWT_SECRET_PREVIOUS_KID: z
    .string()
    .trim()
    .optional()
    .describe("Previous JWT key ID"),

  JWT_SECRET_PREVIOUS_EXPIRES_AT: z
    .string()
    .trim()
    .optional()
    .describe("ISO-8601 timestamp when previous JWT secret expires"),

  JWT_EXPIRES_IN: z
    .string()
    .trim()
    .default("15m")
    .describe("JWT access token lifetime (e.g. '15m')"),

  JWT_REFRESH_EXPIRES_IN: z
    .string()
    .trim()
    .default("7d")
    .describe("JWT refresh token lifetime (e.g. '7d')"),

  NONCE_TTL_SECONDS: z
    .string()
    .trim()
    .default("300")
    .transform(Number)
    .pipe(z.number().positive())
    .describe("Wallet authentication challenge nonce TTL in seconds"),

  PUBLIC_WEB_ORIGIN: z
    .string()
    .trim()
    .default("https://app.inversearena.com")
    .describe("Public origin URL for frontend client web app"),

  // ── Soroban & Stellar ─────────────────────────────────────────────────────
  SOROBAN_RPC_URL: z
    .string()
    .trim()
    .url("SOROBAN_RPC_URL must be a valid URL")
    .default("https://soroban-testnet.stellar.org")
    .describe("Soroban RPC endpoint URL"),

  STELLAR_NETWORK_PASSPHRASE: z
    .string()
    .trim()
    .min(3)
    .default("Test SDF Network ; September 2015")
    .describe("Stellar network passphrase ('Test SDF Network ; September 2015' or public)"),

  PAYOUT_CONTRACT_ID: z
    .string()
    .trim()
    .regex(CONTRACT_ID_REGEX, "PAYOUT_CONTRACT_ID must be a valid Stellar contract ID (C... 56 chars)")
    .describe("Soroban contract ID for payout distribution"),

  PAYOUT_SOURCE_ACCOUNT: z
    .string()
    .trim()
    .regex(ACCOUNT_ID_REGEX, "PAYOUT_SOURCE_ACCOUNT must be a valid Stellar account ID (G... 56 chars)")
    .describe("Stellar account ID for payout transaction source account"),

  ARENA_FACTORY_CONTRACT_ID: z
    .string()
    .trim()
    .regex(CONTRACT_ID_REGEX, "ARENA_FACTORY_CONTRACT_ID must be a valid Stellar contract ID (C... 56 chars)")
    .describe("Soroban contract ID for Arena Factory contract"),

  PAYOUT_METHOD_NAME: z
    .string()
    .trim()
    .default("distribute_winnings")
    .describe("Contract method name invoked for payouts"),

  CONTRACT_MANIFEST_PATH: z
    .string()
    .trim()
    .default("../contract/deployment-manifest.json")
    .describe("Path to local contract deployment manifest JSON"),

  ROUND_CONFIRM_POLL_MS: z
    .string()
    .trim()
    .default("2500")
    .transform(Number)
    .pipe(z.number().positive())
    .describe("Polling interval in ms for on-chain round transaction confirmation"),

  ROUND_CONFIRM_MAX_POLLS: z
    .string()
    .trim()
    .default("20")
    .transform(Number)
    .pipe(z.number().positive())
    .describe("Maximum polling attempts for round confirmation"),

  RPC_MAX_RESPONSE_BYTES: z
    .string()
    .trim()
    .default("1048576")
    .transform(Number)
    .describe("Outbound RPC response size cap in bytes"),

  RPC_URL_ALLOWLIST: z
    .string()
    .trim()
    .optional()
    .describe("Comma-separated list of allowed hostnames for outbound RPC calls"),

  ASSET_ISSUERS: z
    .string()
    .trim()
    .optional()
    .describe("Comma-separated CODE:ISSUER pairs for classic credit assets"),

  // ── Oracle Webhook & Freshness ────────────────────────────────────────────
  ORACLE_WEBHOOK_SECRET: z
    .string()
    .trim()
    .min(1, "ORACLE_WEBHOOK_SECRET must not be empty")
    .describe("Shared secret for verifying incoming Oracle webhooks"),

  ORACLE_WEBHOOK_SECRET_KID: z
    .string()
    .trim()
    .optional()
    .describe("Key identifier for current Oracle webhook secret"),

  ORACLE_WEBHOOK_SECRET_PREVIOUS: z
    .string()
    .trim()
    .optional()
    .describe("Previous Oracle webhook secret during key rotation window"),

  ORACLE_WEBHOOK_SECRET_PREVIOUS_KID: z
    .string()
    .trim()
    .optional()
    .describe("Key identifier for previous Oracle webhook secret"),

  ORACLE_WEBHOOK_SECRET_PREVIOUS_EXPIRES_AT: z
    .string()
    .trim()
    .optional()
    .describe("ISO-8601 expiry timestamp for previous Oracle secret"),

  ORACLE_FRESHNESS_MAX_AGE_SECONDS: z
    .string()
    .trim()
    .default("300")
    .transform(Number)
    .pipe(z.number().positive())
    .describe("Maximum age in seconds for oracle price freshness"),

  ORACLE_FRESHNESS_WARN_THRESHOLD_SECONDS: z
    .string()
    .trim()
    .default("120")
    .transform(Number)
    .pipe(z.number().positive())
    .describe("Warning threshold in seconds for oracle price latency"),

  // ── Protocol Treasury ─────────────────────────────────────────────────────
  TREASURY_DESTINATION: z
    .string()
    .trim()
    .optional()
    .describe("Stellar address designated to receive protocol fees"),

  TREASURY_FINALITY_GRACE_SECONDS: z
    .string()
    .trim()
    .default("120")
    .transform(Number)
    .pipe(z.number().positive())
    .describe("Grace period in seconds before treating un-finalized fee transfer as discrepancy"),

  PLATFORM_FEE_BPS: z
    .string()
    .trim()
    .default("0")
    .transform(Number)
    .pipe(z.number().min(0).max(10000))
    .describe("Platform fee in basis points (0-10000)"),

  // ── Payouts & Workers Execution ───────────────────────────────────────────
  PAYOUTS_LIVE_EXECUTION: z
    .string()
    .trim()
    .default("false")
    .transform((v) => v === "true")
    .describe("Flag to enable live on-chain payout transaction submission"),

  PAYOUTS_SIGN_WITH_HOT_KEY: z
    .string()
    .trim()
    .default("false")
    .transform((v) => v === "true")
    .describe("Flag allowing automated signing with server hot key"),

  PAYOUT_HOT_SIGNER_SECRET: z
    .string()
    .trim()
    .optional()
    .describe("Secret seed (S...) of server hot signer account"),

  PAYOUTS_MAX_GAS_STROOPS: z
    .string()
    .trim()
    .default("2000000")
    .transform(Number)
    .pipe(z.number().positive())
    .describe("Maximum gas in stroops for payout transactions"),

  PAYOUTS_MAX_ATTEMPTS: z
    .string()
    .trim()
    .default("5")
    .transform(Number)
    .pipe(z.number().positive())
    .describe("Maximum submission attempts for payout transactions"),

  PAYOUTS_CONFIRM_POLL_MS: z
    .string()
    .trim()
    .default("2500")
    .transform(Number)
    .pipe(z.number().positive())
    .describe("Polling interval in ms for payout confirmation"),

  PAYOUTS_CONFIRM_MAX_POLLS: z
    .string()
    .trim()
    .default("20")
    .transform(Number)
    .pipe(z.number().positive())
    .describe("Maximum poll attempts for payout confirmation"),

  PAYOUTS_FAILED_RETRY_MAX: z
    .string()
    .trim()
    .default("3")
    .transform(Number)
    .pipe(z.number().min(0))
    .describe("Maximum retries for failed payout worker jobs"),

  PAYOUTS_FAILED_RETRY_BASE_MS: z
    .string()
    .trim()
    .default("5000")
    .transform(Number)
    .pipe(z.number().positive())
    .describe("Base exponential backoff delay in ms for failed payout jobs"),

  TX_WORKER_CONCURRENCY: z
    .string()
    .trim()
    .default("1")
    .transform(Number)
    .pipe(z.number().positive())
    .describe("Concurrency limit for transaction processing worker"),

  PAYOUTS_FEE_SPONSORSHIP_ENABLED: z
    .string()
    .trim()
    .default("false")
    .transform((v) => v === "true")
    .describe("Enable transaction fee sponsorship for payouts"),

  PAYOUTS_FEE_SPONSORSHIP_TTL_HOURS: z
    .string()
    .trim()
    .default("72")
    .transform(Number)
    .pipe(z.number().positive())
    .describe("TTL in hours for sponsored fee vouchers"),

  // ── Rate Limiting (Redis / In-Memory) ──────────────────────────────────────
  RATE_LIMIT_NONCE_PREFIX: z
    .string()
    .trim()
    .default("rl:auth:nonce")
    .describe("Redis key prefix for nonce rate limit bucket"),

  RATE_LIMIT_NONCE_POINTS: z
    .string()
    .trim()
    .default("5")
    .transform(Number)
    .describe("Maximum nonce generation requests per window"),

  RATE_LIMIT_NONCE_WINDOW_SECONDS: z
    .string()
    .trim()
    .default("60")
    .transform(Number)
    .describe("Nonce rate limit window duration in seconds"),

  RATE_LIMIT_POOLS_PREFIX: z
    .string()
    .trim()
    .default("rl:pools:create")
    .describe("Redis key prefix for pool creation rate limit bucket"),

  RATE_LIMIT_POOLS_POINTS: z
    .string()
    .trim()
    .default("3")
    .transform(Number)
    .describe("Maximum pool creations allowed per window"),

  RATE_LIMIT_POOLS_WINDOW_SECONDS: z
    .string()
    .trim()
    .default("60")
    .transform(Number)
    .describe("Pool creation rate limit window duration in seconds"),

  RATE_LIMIT_VERIFY_PREFIX: z
    .string()
    .trim()
    .default("rl:auth:verify")
    .describe("Redis key prefix for auth verification rate limit bucket"),

  RATE_LIMIT_VERIFY_POINTS: z
    .string()
    .trim()
    .default("10")
    .transform(Number)
    .describe("Maximum auth verifications allowed per window"),

  RATE_LIMIT_VERIFY_WINDOW_SECONDS: z
    .string()
    .trim()
    .default("60")
    .transform(Number)
    .describe("Auth verification window duration in seconds"),

  RATE_LIMIT_REFRESH_PREFIX: z
    .string()
    .trim()
    .default("rl:auth:refresh")
    .describe("Redis key prefix for token refresh rate limit bucket"),

  RATE_LIMIT_REFRESH_POINTS: z
    .string()
    .trim()
    .default("20")
    .transform(Number)
    .describe("Maximum token refreshes allowed per window"),

  RATE_LIMIT_REFRESH_WINDOW_SECONDS: z
    .string()
    .trim()
    .default("60")
    .transform(Number)
    .describe("Token refresh rate limit window duration in seconds"),

  RATE_LIMIT_SYNC_PLAYERS_PREFIX: z
    .string()
    .trim()
    .default("rl:arenas:sync-players")
    .describe("Redis key prefix for arena player sync rate limit bucket"),

  RATE_LIMIT_RESERVATION_PREFIX: z
    .string()
    .trim()
    .default("rl:arenas:reservation")
    .describe("Redis key prefix for lobby reservation rate limit bucket"),

  RATE_LIMIT_WALLET_ROLE_PREFIX: z
    .string()
    .trim()
    .default("rl:admin:wallet-role")
    .describe("Redis key prefix for wallet role checking rate limit bucket"),

  SSE_MAX_CONNECTIONS_PER_IP: z
    .string()
    .trim()
    .default("5")
    .transform(Number)
    .describe("Maximum active SSE connections per client IP"),

  SSE_MAX_CONNECTIONS_PER_ARENA: z
    .string()
    .trim()
    .default("100")
    .transform(Number)
    .describe("Maximum active SSE connections per arena channel"),

  // ── Extra Runtime Controls ────────────────────────────────────────────────
  MAX_ACTIVE_STAKE_USDC: z
    .string()
    .trim()
    .default("10000")
    .transform(Number)
    .describe("Maximum active aggregate stake allowed per player in USDC"),

  LOBBY_RESERVATION_TTL_SECONDS: z
    .string()
    .trim()
    .default("120")
    .transform(Number)
    .describe("TTL in seconds for temporary arena lobby reservations"),

  ALIAS_BLOCK_LIST: z
    .string()
    .trim()
    .optional()
    .describe("Comma-separated prohibited words for player display name aliases"),

  ARENA_SIM_SOURCE_SECRET: z
    .string()
    .trim()
    .optional()
    .describe("Secret key for simulating arena transactions in development"),

  ARENA_ADMIN_SECRET: z
    .string()
    .trim()
    .optional()
    .describe("Admin secret key used to sign round resolutions"),
});

export type BackendConfig = z.infer<typeof backendEnvSchema>;

/**
 * Formats backend validation issues into a human-readable bulleted list.
 */
export function formatBackendEnvErrors(issues: z.ZodIssue[]): string {
  const lines = issues.map((issue) => {
    const field = issue.path.join(".") || "(root)";
    return `  • ${field}: ${issue.message}`;
  });

  return [
    "❌ Backend Environment Configuration Error:",
    ...lines,
    "Please check backend/.env against backend/.env.example to configure required variables.",
  ].join("\n");
}

/**
 * Validates backend environment variables and returns a typed configuration object.
 * Fails fast with an informative error if any required variable is missing or malformed.
 */
export function validateBackendEnv(
  rawEnv: NodeJS.ProcessEnv = process.env,
): BackendConfig {
  const isTest = rawEnv.NODE_ENV === "test";

  // Provide sensible defaults for test environments if omitted
  const envToParse = { ...rawEnv };
  if (isTest) {
    envToParse.DATABASE_URL = envToParse.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/inversearena_test";
    envToParse.JWT_SECRET = envToParse.JWT_SECRET ?? "super-secret-test-key-must-be-at-least-32-chars";
    envToParse.ADMIN_API_KEY = envToParse.ADMIN_API_KEY ?? "test-admin-key-at-least-32-chars-long";
    envToParse.ORACLE_WEBHOOK_SECRET = envToParse.ORACLE_WEBHOOK_SECRET ?? "test-oracle-webhook-secret";
    envToParse.PAYOUT_CONTRACT_ID = envToParse.PAYOUT_CONTRACT_ID ?? "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    envToParse.PAYOUT_SOURCE_ACCOUNT = envToParse.PAYOUT_SOURCE_ACCOUNT ?? "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    envToParse.ARENA_FACTORY_CONTRACT_ID = envToParse.ARENA_FACTORY_CONTRACT_ID ?? "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  }

  const result = backendEnvSchema.safeParse(envToParse);
  if (!result.success) {
    throw new Error(formatBackendEnvErrors(result.error.issues));
  }

  return result.data;
}
