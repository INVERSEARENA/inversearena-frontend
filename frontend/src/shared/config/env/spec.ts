/**
 * The frontend's environment schema (#1650), split by where a value may go.
 *
 * - `CLIENT_ENV_VARS`: `NEXT_PUBLIC_*` values that Next.js inlines into the
 *   browser bundle. Anything here is public.
 * - `SERVER_ENV_VARS`: read only on the server (route handlers, the proxy,
 *   the build). They must never be given a `NEXT_PUBLIC_` prefix.
 *
 * `frontend/.env.example` is generated from these declarations by
 * `scripts/env-example.ts`, and CI fails when it drifts. This module has no
 * Node or browser dependencies, so it runs in the Edge runtime, the browser
 * and `next.config.ts` alike.
 */
import { z } from "zod";

export interface EnvVarSpec {
  /** Heading the variable is grouped under in `.env.example`. */
  section: string;
  description: string;
  /** Value written to `.env.example`. Give secrets one only if it is a safe local value. */
  example?: string;
  /** Behaviour when unset, for the docs. */
  default?: string;
  /** A production build fails when unset. */
  required?: boolean;
  /** Never logged or printed. */
  secret?: boolean;
  /** Validates the raw string when the variable is set. */
  schema: z.ZodType<string>;
}

const url = z.string().url("must be a URL");
const flag = z.enum(["true", "false"], { message: 'must be "true" or "false"' });
/** Lenient on purpose: test fixtures use readable placeholder ids. */
const contractId = z.string().trim().min(3, "must be a contract id (C...)");
const issuer = z.string().regex(/^G[A-Z2-7]{55}$/, "must be a Stellar account id (G + 55 base32 chars)");

export const CLIENT_ENV_VARS = {
  // ── Stellar / Soroban ──────────────────────────────────────────────────────
  NEXT_PUBLIC_STELLAR_NETWORK: {
    section: "Stellar / Soroban",
    description: "Network the app targets.",
    example: "testnet",
    default: "testnet",
    schema: z.string().transform((v) => v.toLowerCase()).pipe(z.enum(["testnet", "mainnet"])),
  },
  NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE: {
    section: "Stellar / Soroban",
    description: "Overrides the passphrase implied by NEXT_PUBLIC_STELLAR_NETWORK.",
    schema: z.string().trim().min(3),
  },
  NEXT_PUBLIC_SOROBAN_RPC_URL: {
    section: "Stellar / Soroban",
    description: "Soroban RPC endpoint.",
    example: "https://soroban-testnet.stellar.org",
    required: true,
    schema: url,
  },
  NEXT_PUBLIC_HORIZON_URL: {
    section: "Stellar / Soroban",
    description: "Horizon endpoint.",
    example: "https://horizon-testnet.stellar.org",
    required: true,
    schema: url,
  },
  NEXT_PUBLIC_FACTORY_CONTRACT_ID: {
    section: "Stellar / Soroban",
    description: "Arena factory contract.",
    example: "C...",
    required: true,
    schema: contractId,
  },
  NEXT_PUBLIC_USDC_CONTRACT_ID: {
    section: "Stellar / Soroban",
    description: "USDC token contract.",
    example: "C...",
    required: true,
    schema: contractId,
  },
  NEXT_PUBLIC_XLM_CONTRACT_ID: {
    section: "Stellar / Soroban",
    description: "Native XLM Stellar Asset Contract. Defaults to the testnet SAC.",
    schema: contractId,
  },
  NEXT_PUBLIC_STAKING_CONTRACT_ID: { section: "Stellar / Soroban", description: "Staking contract.", schema: contractId },
  NEXT_PUBLIC_RWA_VAULT_CONTRACT_ID: { section: "Stellar / Soroban", description: "RWA yield vault adapter.", schema: contractId },
  NEXT_PUBLIC_ORACLE_CONTRACT_ID: { section: "Stellar / Soroban", description: "Yield oracle contract.", schema: contractId },

  // ── Classic asset issuers (#1487) ──────────────────────────────────────────
  NEXT_PUBLIC_USDC_ISSUER: {
    section: "Classic asset issuers",
    description:
      "Issuer of classic USDC. A changeTrust is keyed by the exact (code, issuer) pair, so the app never guesses one: when unset, every USDC action is blocked with a message naming this variable. Must match the backend's ASSET_ISSUERS.",
    schema: issuer,
  },
  NEXT_PUBLIC_EURC_ISSUER: {
    section: "Classic asset issuers",
    description: "Issuer of classic EURC. Same rules as NEXT_PUBLIC_USDC_ISSUER.",
    schema: issuer,
  },

  // ── App ────────────────────────────────────────────────────────────────────
  NEXT_PUBLIC_API_BASE_URL: {
    section: "App",
    description: "Backend API origin.",
    example: "http://localhost:4000",
    default: "http://localhost:4000",
    schema: url,
  },
  NEXT_PUBLIC_APP_ORIGIN: {
    section: "App",
    description: "This app's public origin, added to the CORS allowlist by the proxy.",
    schema: url,
  },
  NEXT_PUBLIC_SITE_URL: {
    section: "App",
    description: "Public site origin used in the sitemap.",
    default: "https://app.inversearena.io",
    schema: url,
  },
  NEXT_PUBLIC_DEMO_ARENA_ID: {
    section: "App",
    description: "Arena contract shown on /arena. When unset the page shows static demo data.",
    schema: contractId,
  },
  NEXT_PUBLIC_TELEMETRY_POLL_INTERVAL_MS: {
    section: "App",
    description: "Dashboard telemetry refresh interval.",
    default: "60000",
    schema: z.string().regex(/^\d+$/, "must be a positive integer"),
  },
  NEXT_PUBLIC_COINGECKO_SIMPLE_PRICE_URL: {
    section: "App",
    description: "Price endpoint for the telemetry bar. Defaults to CoinGecko's public simple-price API.",
    schema: url,
  },
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: {
    section: "App",
    description:
      "Base64url VAPID public key from the backend's keypair (#1571). The push opt-in reports not-configured when unset.",
    schema: z.string().min(1),
  },
  NEXT_PUBLIC_PASSKEY_DEMO_MODE: {
    section: "App",
    description: "Enable the passkey demo wallet. Always off in production builds.",
    default: "false",
    schema: flag,
  },
  NEXT_PUBLIC_USE_MOCK_PROFILE: {
    section: "App",
    description: "Serve profile data from fixtures instead of the API.",
    default: "false",
    schema: flag,
  },

  // ── Sentry ─────────────────────────────────────────────────────────────────
  NEXT_PUBLIC_SENTRY_DSN: {
    section: "Sentry",
    description: "Sentry DSN (public by design). Leave unset to disable error reporting.",
    schema: url,
  },
  NEXT_PUBLIC_SENTRY_ENVIRONMENT: {
    section: "Sentry",
    description: "Environment label in Sentry. Defaults to NODE_ENV.",
    schema: z.string().min(1),
  },
  NEXT_PUBLIC_SENTRY_RELEASE: {
    section: "Sentry",
    description: "Release identifier, set by CI to the git SHA or tag.",
    schema: z.string().min(1),
  },
} satisfies Record<`NEXT_PUBLIC_${string}`, EnvVarSpec>;

export const SERVER_ENV_VARS = {
  ALLOWED_ORIGINS: {
    section: "Server (never exposed to the browser)",
    description: "Comma-separated extra origins allowed by the proxy's CORS policy.",
    schema: z.string(),
  },
  REDIS_URL: {
    section: "Server (never exposed to the browser)",
    description:
      "Redis for a shared rate limit across instances. Unset falls back to per-process counting (effective limit = points × instances).",
    secret: true,
    schema: url,
  },
  TRUSTED_PROXY_COUNT: {
    section: "Server (never exposed to the browser)",
    description:
      "Reverse proxies in front of the app. Controls how X-Forwarded-For is read for rate-limit buckets; 0 ignores the header so callers cannot spoof it.",
    example: "0",
    default: "0",
    schema: z.string().regex(/^\d+$/, "must be a non-negative integer"),
  },
  SENTRY_AUTH_TOKEN: {
    section: "Server (never exposed to the browser)",
    description: "Uploads source maps to Sentry during `next build`. Build-time only.",
    secret: true,
    schema: z.string().min(1),
  },
  SKIP_ENV_VALIDATION: {
    section: "Server (never exposed to the browser)",
    description:
      "Set to 1 to skip schema validation in `next build`, e.g. for an image built before its environment exists. The NEXT_PUBLIC_ secret check still runs.",
    schema: z.enum(["0", "1", "true", "false"]),
  },
} satisfies Record<string, EnvVarSpec>;

export type ClientEnvKey = keyof typeof CLIENT_ENV_VARS;
export type ServerEnvKey = keyof typeof SERVER_ENV_VARS;

export interface EnvIssue {
  name: string;
  message: string;
}

export class EnvValidationError extends Error {
  constructor(
    readonly issues: EnvIssue[],
    heading = "Invalid environment configuration",
  ) {
    super(
      `${heading} (${issues.length} variable${issues.length === 1 ? "" : "s"}):\n` +
        issues.map((issue) => `  - ${issue.name}: ${issue.message}`).join("\n") +
        "\nSee frontend/.env.example for every variable and its format.",
    );
    this.name = "EnvValidationError";
  }
}

type Source = Readonly<Record<string, string | undefined>>;

const valueOf = (source: Source, name: string) => {
  const value = source[name];
  return value === undefined || value.trim() === "" ? undefined : value;
};

/** Every issue in `source` against `specs`. Never includes values. */
export function checkEnv(specs: Readonly<Record<string, EnvVarSpec>>, source: Source): EnvIssue[] {
  const issues: EnvIssue[] = [];
  for (const [name, spec] of Object.entries(specs)) {
    const value = valueOf(source, name);
    if (value === undefined) {
      if (spec.required) issues.push({ name, message: "is required but not set" });
      continue;
    }
    const result = spec.schema.safeParse(value);
    if (!result.success) issues.push({ name, message: result.error.issues.map((i) => i.message).join("; ") });
  }
  return issues;
}

/**
 * Names that suggest a secret. A `NEXT_PUBLIC_` variable is compiled into the
 * browser bundle, so one of these is a leak no matter what it holds.
 */
const SECRET_NAME =
  /SECRET|PRIVATE|PASSWORD|PASSWD|TOKEN|CREDENTIAL|MNEMONIC|SEED|API_?KEY|ACCESS_KEY|SIGNING_KEY|ENCRYPTION_KEY|DATABASE_URL|MONGODB_URI|REDIS_URL|JWT/;

/** Values that are secrets whatever they are called. */
const SECRET_VALUES: ReadonlyArray<[RegExp, string]> = [
  [/^S[A-Z2-7]{55}$/, "a Stellar secret seed"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a PEM private key"],
];

/**
 * `NEXT_PUBLIC_` variables in `source` that look like secrets, by name or by
 * value. Values are never echoed back.
 */
export function findPublicSecretExposures(source: Source): EnvIssue[] {
  const issues: EnvIssue[] = [];
  for (const [name, raw] of Object.entries(source)) {
    if (!name.startsWith("NEXT_PUBLIC_") || raw === undefined || raw.trim() === "") continue;
    if (SECRET_NAME.test(name.slice("NEXT_PUBLIC_".length))) {
      issues.push({
        name,
        message: "looks like a secret; NEXT_PUBLIC_ variables are inlined into the browser bundle. Drop the prefix and read it on the server.",
      });
      continue;
    }
    const match = SECRET_VALUES.find(([pattern]) => pattern.test(raw.trim()));
    if (match) issues.push({ name, message: `holds ${match[1]}, which would ship in the browser bundle` });
  }
  return issues;
}
