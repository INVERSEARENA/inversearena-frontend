import { z } from "zod";
import type { EnvVarSpec } from "../envSpec";
import { accountId, contractId, csv, decimal, flag, int, isoTimestamp, kid, rateLimit, rotation, secretSeed, text, url } from "../envSpec";

export const oracleEnvVars = {
  ORACLE_WEBHOOK_SECRET: {
    section: "Oracle",
    description: "Shared secret for the oracle webhook, at least 16 characters. Senders may name the key via `x-oracle-key-id`.",
    secret: true,
    schema: text,
  },
  ...rotation("ORACLE_WEBHOOK_SECRET", "Oracle"),
  ORACLE_MAX_AGE_SECONDS: {
    section: "Oracle",
    description: "Oldest oracle observation accepted for yield-dependent actions (#1512). At most 86400.",
    default: "3600",
    schema: int(1, 86_400),
  },
  ORACLE_WARN_AGE_SECONDS: {
    section: "Oracle",
    description: "Observation age that triggers a staleness warning. Must not exceed ORACLE_MAX_AGE_SECONDS.",
    default: "1800",
    schema: int(1),
  }
} satisfies Record<string, EnvVarSpec>;
