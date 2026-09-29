import { z } from "zod";

/**
 * Oracle freshness policy config (#1512).
 *
 * Mirrors the contract-side default policy (`contract/arena/src/types.rs`'s
 * `OracleFreshnessPolicy`) so the backend's own independent freshness check
 * (used before trusting a client-submitted `oracleYield` — see
 * `oracleFreshnessService.ts`) applies the same thresholds an arena's
 * on-chain `resolve_round` would, by default. Since each arena instance can
 * independently reconfigure its own on-chain policy, the backend's config is
 * a default / fallback for reads that don't (or can't) consult the specific
 * arena's on-chain policy — not a claim that every arena shares it.
 */

/** Bump only on a breaking shape change to this config's fields. */
export const ORACLE_FRESHNESS_CONFIG_VERSION = 1 as const;

const DEFAULT_MAX_AGE_SECONDS = 3_600;
const DEFAULT_WARN_AGE_SECONDS = 1_800;
/** Hard ceiling — mirrors `contract/arena/src/types.rs`'s `MAX_ORACLE_MAX_AGE_SECS`. */
const HARD_CEILING_SECONDS = 86_400;

const OracleFreshnessEnvSchema = z
  .object({
    ORACLE_MAX_AGE_SECONDS: z
      .string()
      .optional()
      .transform((v) => Number(v ?? String(DEFAULT_MAX_AGE_SECONDS)))
      .pipe(z.number().int().positive().max(HARD_CEILING_SECONDS)),
    ORACLE_WARN_AGE_SECONDS: z
      .string()
      .optional()
      .transform((v) => Number(v ?? String(DEFAULT_WARN_AGE_SECONDS)))
      .pipe(z.number().int().positive()),
  })
  .refine((cfg) => cfg.ORACLE_WARN_AGE_SECONDS <= cfg.ORACLE_MAX_AGE_SECONDS, {
    message: "ORACLE_WARN_AGE_SECONDS must not exceed ORACLE_MAX_AGE_SECONDS",
    path: ["ORACLE_WARN_AGE_SECONDS"],
  });

export interface OracleFreshnessConfig {
  version: typeof ORACLE_FRESHNESS_CONFIG_VERSION;
  maxAgeSeconds: number;
  warnAgeSeconds: number;
}

/**
 * Parses and validates the oracle freshness policy from the environment.
 * Throws at startup (not at first use) on an invalid combination — a
 * misconfigured freshness policy must never silently disable staleness
 * enforcement for the process's whole lifetime.
 */
export function getOracleFreshnessConfig(
  env: NodeJS.ProcessEnv = process.env,
): OracleFreshnessConfig {
  const parsed = OracleFreshnessEnvSchema.parse({
    ORACLE_MAX_AGE_SECONDS: env.ORACLE_MAX_AGE_SECONDS,
    ORACLE_WARN_AGE_SECONDS: env.ORACLE_WARN_AGE_SECONDS,
  });

  return {
    version: ORACLE_FRESHNESS_CONFIG_VERSION,
    maxAgeSeconds: parsed.ORACLE_MAX_AGE_SECONDS,
    warnAgeSeconds: parsed.ORACLE_WARN_AGE_SECONDS,
  };
}
