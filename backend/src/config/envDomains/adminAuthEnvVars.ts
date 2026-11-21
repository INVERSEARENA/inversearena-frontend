import { z } from "zod";
import type { EnvVarSpec } from "../envSpec";
import { accountId, contractId, csv, decimal, flag, int, isoTimestamp, kid, rateLimit, rotation, secretSeed, text, url } from "../envSpec";

export const adminAuthEnvVars = {
  ADMIN_API_KEY: {
    section: "Admin auth",
    description:
      "Admin API key. At least 32 characters to resist brute-force and timing attacks. Generate with `openssl rand -hex 32`.",
    required: true,
    secret: true,
    schema: z
      .string()
      .min(32, "must be at least 32 characters")
      .refine((value) => value !== "change-me-in-production", "must be changed from the default value"),
  },
  ADMIN_TOKEN_TTL_SECONDS: {
    section: "Admin auth",
    description: "Admin confirmation token TTL in seconds: at least 300, or 0 for API-key auth only.",
    example: "900",
    default: "900",
    schema: int(0),
  },
  ADMIN_WALLET_ADDRESSES: {
    section: "Admin auth",
    description:
      "Comma-separated Stellar public keys allowed to manage arenas from /dashboard/admin. Being connected is not enough: only these addresses get isAdmin.",
    schema: csv(accountId, "Stellar account ids"),
  }
} satisfies Record<string, EnvVarSpec>;
