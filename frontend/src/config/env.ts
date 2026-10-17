import { z } from "zod";

/**
 * Regular expression matching secret-looking variable names.
 * Any variable matching this pattern must NEVER be exposed to the client bundle
 * via a NEXT_PUBLIC_ prefix.
 */
export const SECRET_KEY_PATTERN =
  /(?:SECRET|PRIVATE_KEY|PASSWORD|AUTH_TOKEN|API_KEY|KEYRING|SEED|MNEMONIC)/i;

/**
 * Public client-side schema for Next.js.
 * All variables here are safe to expose to client browsers and must be prefixed
 * with NEXT_PUBLIC_.
 */
export const clientEnvSchema = z.object({
  NEXT_PUBLIC_STELLAR_NETWORK: z
    .enum(["testnet", "mainnet"])
    .default("testnet")
    .describe("Stellar network to connect to ('testnet' or 'mainnet')"),

  NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE: z
    .string()
    .trim()
    .min(3)
    .optional()
    .describe("Custom Stellar network passphrase; defaults to public or testnet passphrase"),

  NEXT_PUBLIC_SOROBAN_RPC_URL: z
    .string()
    .trim()
    .url()
    .describe("Soroban RPC endpoint URL"),

  NEXT_PUBLIC_HORIZON_URL: z
    .string()
    .trim()
    .url()
    .describe("Horizon API endpoint URL"),

  NEXT_PUBLIC_FACTORY_CONTRACT_ID: z
    .string()
    .trim()
    .min(3)
    .describe("Stellar contract ID for Arena Factory contract"),

  NEXT_PUBLIC_USDC_CONTRACT_ID: z
    .string()
    .trim()
    .min(3)
    .describe("Soroban token contract ID for USDC"),

  NEXT_PUBLIC_XLM_CONTRACT_ID: z
    .string()
    .trim()
    .min(3)
    .optional()
    .describe("Soroban contract ID for native XLM token wrapper (defaults to standard testnet/mainnet id)"),

  NEXT_PUBLIC_STAKING_CONTRACT_ID: z
    .string()
    .trim()
    .min(3)
    .optional()
    .describe("Stellar contract ID for Staking contract"),

  NEXT_PUBLIC_RWA_VAULT_CONTRACT_ID: z
    .string()
    .trim()
    .min(3)
    .optional()
    .describe("Stellar contract ID for RWA Vault contract"),

  NEXT_PUBLIC_ORACLE_CONTRACT_ID: z
    .string()
    .trim()
    .min(3)
    .optional()
    .describe("Stellar contract ID for Oracle contract"),

  NEXT_PUBLIC_APP_ORIGIN: z
    .string()
    .trim()
    .url()
    .optional()
    .describe("Canonical frontend application origin URL (e.g. https://inversearena.com)"),

  NEXT_PUBLIC_CONTRACT_MANIFEST_PATH: z
    .string()
    .trim()
    .optional()
    .describe("Optional path to local contract deployment manifest JSON"),

  NEXT_PUBLIC_USDC_ISSUER: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Classic credit-asset issuer public key (G...) for USDC"),

  NEXT_PUBLIC_EURC_ISSUER: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Classic credit-asset issuer public key (G...) for EURC"),

  NEXT_PUBLIC_DEMO_ARENA_ID: z
    .string()
    .trim()
    .optional()
    .describe("Stellar contract address of the arena to display on /arena"),

  NEXT_PUBLIC_API_BASE_URL: z
    .string()
    .trim()
    .url()
    .optional()
    .describe("Base URL for backend API calls (defaults to http://localhost:4000)"),

  NEXT_PUBLIC_USE_MOCK_PROFILE: z
    .enum(["true", "false"])
    .optional()
    .describe("Toggle mock profile data in development ('true' or 'false')"),

  NEXT_PUBLIC_PASSKEY_DEMO_MODE: z
    .enum(["true", "false"])
    .optional()
    .describe("Toggle passkey demo mode in development ('true' or 'false')"),

  NEXT_PUBLIC_TELEMETRY_POLL_INTERVAL_MS: z
    .string()
    .trim()
    .regex(/^\d+$/)
    .optional()
    .describe("Telemetry polling interval in milliseconds"),

  NEXT_PUBLIC_SENTRY_DSN: z
    .string()
    .trim()
    .url()
    .or(z.literal(""))
    .optional()
    .describe("Sentry DSN for error reporting in frontend"),

  NEXT_PUBLIC_SENTRY_ENVIRONMENT: z
    .string()
    .trim()
    .optional()
    .describe("Sentry environment tag (defaults to NODE_ENV)"),

  NEXT_PUBLIC_SENTRY_RELEASE: z
    .string()
    .trim()
    .optional()
    .describe("Sentry release identifier"),
});

/**
 * Server-only schema for Next.js.
 * These variables are never bundled to the client.
 */
export const serverEnvSchema = z.object({
  ALLOWED_ORIGINS: z
    .string()
    .trim()
    .optional()
    .describe("Comma-separated list of allowed CORS origins for API routes"),

  REDIS_URL: z
    .string()
    .trim()
    .url()
    .optional()
    .describe("Redis connection URL for distributed rate limiting"),

  TRUSTED_PROXY_COUNT: z
    .string()
    .trim()
    .regex(/^\d+$/)
    .optional()
    .describe("Number of trusted reverse proxies in front of the application"),

  SENTRY_AUTH_TOKEN: z
    .string()
    .trim()
    .optional()
    .describe("Sentry auth token for uploading source maps during CI/CD build"),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * Detects any secret-looking variables erroneously prefixed with NEXT_PUBLIC_.
 */
export function detectLeakedSecrets(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const leaked: string[] = [];
  for (const key of Object.keys(env)) {
    if (key.startsWith("NEXT_PUBLIC_")) {
      const suffix = key.slice("NEXT_PUBLIC_".length);
      if (SECRET_KEY_PATTERN.test(suffix)) {
        leaked.push(key);
      }
    }
  }
  return leaked;
}

/**
 * Formats Zod validation issues into a clean, human-readable error list.
 */
export function formatEnvIssues(issues: z.ZodIssue[]): string {
  const lines = issues.map((issue) => {
    const path = issue.path.join(".") || "(root)";
    return `  - ${path}: ${issue.message}`;
  });
  return [
    "❌ Invalid environment variables:",
    ...lines,
    "Please check your environment configuration against .env.example.",
  ].join("\n");
}

/**
 * Validates frontend environment at boot or build time.
 * Throws fast with a readable error message if validation fails or a secret is leaked.
 */
export function validateFrontendEnv(
  env: Record<string, string | undefined> = process.env,
  options: { isBuild?: boolean; checkServer?: boolean } = {},
): { client: ClientEnv; server?: ServerEnv | undefined } {
  // 1. Guard against secret leak to client bundle
  const leakedSecrets = detectLeakedSecrets(env);
  if (leakedSecrets.length > 0) {
    throw new Error(
      `Security Error: Secret-looking environment variable(s) exposed to client via NEXT_PUBLIC_:\n${leakedSecrets
        .map((k) => `  - ${k}`)
        .join("\n")}\nNever expose server secrets to the client bundle!`
    );
  }

  // 2. Validate client schema
  const clientResult = clientEnvSchema.safeParse(env);
  const issues: z.ZodIssue[] = [];

  if (!clientResult.success) {
    issues.push(...clientResult.error.issues);
  }

  // 3. Validate server schema if running in Node.js / server runtime
  const checkServer = options.checkServer ?? (typeof window === "undefined");
  let serverData: ServerEnv | undefined;

  if (checkServer) {
    const serverResult = serverEnvSchema.safeParse(env);
    if (!serverResult.success) {
      issues.push(...serverResult.error.issues);
    } else {
      serverData = serverResult.data;
    }
  }

  if (issues.length > 0) {
    throw new Error(formatEnvIssues(issues));
  }

  const result: { client: ClientEnv; server?: ServerEnv | undefined } = {
    client: clientResult.data as ClientEnv,
  };
  if (serverData !== undefined) {
    result.server = serverData;
  }
  return result;
}
