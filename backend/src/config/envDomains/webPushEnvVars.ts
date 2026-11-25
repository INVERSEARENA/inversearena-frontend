import { z } from "zod";
import type { EnvVarSpec } from "../envSpec";
import { accountId, contractId, csv, decimal, flag, int, isoTimestamp, kid, rateLimit, rotation, secretSeed, text, url } from "../envSpec";

export const webPushEnvVars = {
  VAPID_PUBLIC_KEY: {
    section: "Web Push",
    description: "Base64url VAPID public key (65-byte uncompressed point). Push is disabled when unset.",
    schema: text,
  },
  VAPID_PRIVATE_KEY: {
    section: "Web Push",
    description:
      "PEM-encoded EC private key for VAPID. Generate with `openssl ecparam -genkey -name prime256v1 -noout`.",
    secret: true,
    schema: text,
  },
  VAPID_SUBJECT: {
    section: "Web Push",
    description: "Contact sent as the VAPID `sub` claim (mailto: or https: URL).",
    example: "mailto:ops@example.com",
    schema: z.string().regex(/^(mailto:|https:\/\/)/, "must start with mailto: or https://"),
  },
  PUSH_ENCRYPTION_KEY: {
    section: "Web Push",
    description: "AES-256-GCM key for stored push keys: 64 hex chars. Generate with `openssl rand -hex 32`.",
    secret: true,
    schema: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters"),
  }
} satisfies Record<string, EnvVarSpec>;
