import { z } from "zod";
import { getStellarConfig } from "./stellarConfig";

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
});

export type PaymentConfig = ReturnType<typeof getPaymentConfig>;

export function getPaymentConfig() {
  const stellar = getStellarConfig();
  const parsed = EnvSchema.parse({
    PAYOUTS_LIVE_EXECUTION: process.env.PAYOUTS_LIVE_EXECUTION,
    PAYOUTS_SIGN_WITH_HOT_KEY: process.env.PAYOUTS_SIGN_WITH_HOT_KEY,
    PAYOUTS_MAX_GAS_STROOPS: process.env.PAYOUTS_MAX_GAS_STROOPS,
    PAYOUTS_MAX_ATTEMPTS: process.env.PAYOUTS_MAX_ATTEMPTS,
    PAYOUTS_CONFIRM_POLL_MS: process.env.PAYOUTS_CONFIRM_POLL_MS,
    PAYOUTS_CONFIRM_MAX_POLLS: process.env.PAYOUTS_CONFIRM_MAX_POLLS,
    PAYOUTS_FAILED_RETRY_MAX: process.env.PAYOUTS_FAILED_RETRY_MAX,
    PAYOUTS_FAILED_RETRY_BASE_MS: process.env.PAYOUTS_FAILED_RETRY_BASE_MS,
    PAYOUT_METHOD_NAME: process.env.PAYOUT_METHOD_NAME,
    PAYOUT_CONTRACT_ID: process.env.PAYOUT_CONTRACT_ID,
    PAYOUT_SOURCE_ACCOUNT: process.env.PAYOUT_SOURCE_ACCOUNT,
    PAYOUT_HOT_SIGNER_SECRET: process.env.PAYOUT_HOT_SIGNER_SECRET,
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
  };
}
