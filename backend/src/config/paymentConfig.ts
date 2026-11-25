import { z } from "zod";
import { getStellarConfig } from "./stellarConfig";
import { processEnv } from "./env";

const parseBooleanFlag = (value: string | undefined): boolean =>
  value === "true" || value === "1";

// Soroban contract address: C + 55 base-32 chars (total 56)
const stellarContractId = z
  .string()
  .regex(/^C[A-Z2-7]{55}$/, "must be a valid Stellar contract ID (C...)");

// Stellar account address: G + 55 base-32 chars (total 56)
const stellarAccountId = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, "must be a valid Stellar account ID (G...)");

const EnvSchema = z.object({
  PAYOUTS_LIVE_EXECUTION: z
    .string()
    .optional()
    .transform(parseBooleanFlag),
  PAYOUTS_SIGN_WITH_HOT_KEY: z
    .string()
    .optional()
    .transform(parseBooleanFlag),
  PAYOUTS_MAX_GAS_STROOPS: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "2000000"))
    .pipe(z.number().int().positive()),
  PAYOUTS_MAX_ATTEMPTS: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "5"))
    .pipe(z.number().int().positive()),
  PAYOUTS_CONFIRM_POLL_MS: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "2500"))
    .pipe(z.number().int().positive()),
  PAYOUTS_CONFIRM_MAX_POLLS: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "20"))
    .pipe(z.number().int().positive()),
  PAYOUTS_FAILED_RETRY_MAX: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "3"))
    .pipe(z.number().int().nonnegative()),
  PAYOUTS_FAILED_RETRY_BASE_MS: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "5000"))
    .pipe(z.number().int().positive()),
  PAYOUT_METHOD_NAME: z.string().optional(),
  PAYOUT_CONTRACT_ID: stellarContractId,
  PAYOUT_SOURCE_ACCOUNT: stellarAccountId,
  PAYOUT_HOT_SIGNER_SECRET: z.string().optional(),
  // Issue #1413 — fee sponsorship
  PAYOUTS_FEE_SPONSORSHIP_ENABLED: z
    .string()
    .optional()
    .transform(parseBooleanFlag),
  PAYOUTS_FEE_SPONSORSHIP_TTL_HOURS: z
    .string()
    .optional()
    .transform((v) => Number(v ?? "72"))
    .pipe(z.number().int().positive()),
});

export type PaymentConfig = ReturnType<typeof getPaymentConfig>;

export function getPaymentConfig() {
  const stellar = getStellarConfig();
  const parsed = EnvSchema.parse({
    PAYOUTS_LIVE_EXECUTION: processEnv.PAYOUTS_LIVE_EXECUTION,
    PAYOUTS_SIGN_WITH_HOT_KEY: processEnv.PAYOUTS_SIGN_WITH_HOT_KEY,
    PAYOUTS_MAX_GAS_STROOPS: processEnv.PAYOUTS_MAX_GAS_STROOPS,
    PAYOUTS_MAX_ATTEMPTS: processEnv.PAYOUTS_MAX_ATTEMPTS,
    PAYOUTS_CONFIRM_POLL_MS: processEnv.PAYOUTS_CONFIRM_POLL_MS,
    PAYOUTS_CONFIRM_MAX_POLLS: processEnv.PAYOUTS_CONFIRM_MAX_POLLS,
    PAYOUTS_FAILED_RETRY_MAX: processEnv.PAYOUTS_FAILED_RETRY_MAX,
    PAYOUTS_FAILED_RETRY_BASE_MS: processEnv.PAYOUTS_FAILED_RETRY_BASE_MS,
    PAYOUT_METHOD_NAME: processEnv.PAYOUT_METHOD_NAME,
    PAYOUT_CONTRACT_ID: processEnv.PAYOUT_CONTRACT_ID,
    PAYOUT_SOURCE_ACCOUNT: processEnv.PAYOUT_SOURCE_ACCOUNT,
    PAYOUT_HOT_SIGNER_SECRET: processEnv.PAYOUT_HOT_SIGNER_SECRET,
    PAYOUTS_FEE_SPONSORSHIP_ENABLED: processEnv.PAYOUTS_FEE_SPONSORSHIP_ENABLED,
    PAYOUTS_FEE_SPONSORSHIP_TTL_HOURS: processEnv.PAYOUTS_FEE_SPONSORSHIP_TTL_HOURS,
  });

  return {
    liveExecution: parsed.PAYOUTS_LIVE_EXECUTION,
    signWithHotKey: parsed.PAYOUTS_SIGN_WITH_HOT_KEY,
    maxGasStroops: parsed.PAYOUTS_MAX_GAS_STROOPS,
    maxAttempts: parsed.PAYOUTS_MAX_ATTEMPTS,
    confirmPollMs: parsed.PAYOUTS_CONFIRM_POLL_MS,
    confirmMaxPolls: parsed.PAYOUTS_CONFIRM_MAX_POLLS,
    failedRetryMax: parsed.PAYOUTS_FAILED_RETRY_MAX,
    failedRetryBaseMs: parsed.PAYOUTS_FAILED_RETRY_BASE_MS,
    payoutMethodName: parsed.PAYOUT_METHOD_NAME ?? "distribute_winnings",
    payoutContractId: parsed.PAYOUT_CONTRACT_ID,
    sourceAccount: parsed.PAYOUT_SOURCE_ACCOUNT,
    hotSignerSecret: parsed.PAYOUT_HOT_SIGNER_SECRET,
    networkPassphrase: stellar.networkPassphrase,
    sorobanRpcUrl: stellar.sorobanRpcUrl,
    // Issue #1413
    feeSponsorshipEnabled: parsed.PAYOUTS_FEE_SPONSORSHIP_ENABLED,
    feeSponsorshipTtlHours: parsed.PAYOUTS_FEE_SPONSORSHIP_TTL_HOURS,
  };
}
