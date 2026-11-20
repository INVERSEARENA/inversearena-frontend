import { z } from "zod";
import type { EnvVarSpec } from "../envSpec";
import { accountId, contractId, csv, decimal, flag, int, isoTimestamp, kid, rateLimit, rotation, secretSeed, text, url } from "../envSpec";

export const walletAuthEnvVars = {
  JWT_SECRET: {
    section: "Wallet auth (JWT)",
    description: "JWT signing secret, at least 32 characters. Generate with `openssl rand -hex 32`.",
    required: true,
    secret: true,
    schema: z.string().min(32, "must be at least 32 characters"),
  },
  ...rotation("JWT_SECRET", "Wallet auth (JWT)"),
  JWT_ACCESS_EXPIRES_IN: {
    section: "Wallet auth (JWT)",
    description: "Access token lifetime in seconds.",
    default: "900",
    schema: int(1),
  },
  JWT_REFRESH_EXPIRES_IN: {
    section: "Wallet auth (JWT)",
    description: "Refresh token lifetime in seconds.",
    default: "604800",
    schema: int(1),
  },
  NONCE_TTL_SECONDS: {
    section: "Wallet auth (JWT)",
    description: "Sign-in nonce lifetime in seconds.",
    default: "300",
    schema: int(1),
  }
} satisfies Record<string, EnvVarSpec>;
