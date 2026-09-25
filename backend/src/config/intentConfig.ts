import { z } from "zod";

const EnvSchema = z.object({
  // How long an intent stays valid after creation before the service marks
  // it expired on next read (#1381). Matches the ~5 minute window Stellar
  // transaction time-bounds typically use elsewhere in this codebase
  // (TRANSACTION_CONFIG.TIMEOUT_SECONDS in the frontend), so an intent
  // rarely outlives the envelope it wraps.
  INTENT_TTL_MS: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "300000"))
    .pipe(z.number().int().positive()),
  INTENT_MAX_SIGN_ATTEMPTS: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "5"))
    .pipe(z.number().int().positive()),
});

export type IntentConfig = ReturnType<typeof getIntentConfig>;

export function getIntentConfig() {
  const parsed = EnvSchema.parse({
    INTENT_TTL_MS: process.env.INTENT_TTL_MS,
    INTENT_MAX_SIGN_ATTEMPTS: process.env.INTENT_MAX_SIGN_ATTEMPTS,
  });

  return {
    ttlMs: parsed.INTENT_TTL_MS,
    maxSignAttempts: parsed.INTENT_MAX_SIGN_ATTEMPTS,
  };
}
