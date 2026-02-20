import { z } from "zod";

const parseBooleanFlag = (value: string | undefined): boolean =>
  value === "true" || value === "1";

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
  PAYOUT_METHOD_NAME: z.string().optional(),
  PAYOUT_CONTRACT_ID: z.string().min(3),
  PAYOUT_SOURCE_ACCOUNT: z.string().min(3),
  PAYOUT_HOT_SIGNER_SECRET: z.string().optional(),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(3),
  SOROBAN_RPC_URL: z.string().url(),
});

export type PaymentConfig = ReturnType<typeof getPaymentConfig>;

export function getPaymentConfig() {
  const parsed = EnvSchema.parse({
    PAYOUTS_LIVE_EXECUTION: process.env.PAYOUTS_LIVE_EXECUTION,
    PAYOUTS_SIGN_WITH_HOT_KEY: process.env.PAYOUTS_SIGN_WITH_HOT_KEY,
    PAYOUTS_MAX_GAS_STROOPS: process.env.PAYOUTS_MAX_GAS_STROOPS,
    PAYOUTS_MAX_ATTEMPTS: process.env.PAYOUTS_MAX_ATTEMPTS,
    PAYOUTS_CONFIRM_POLL_MS: process.env.PAYOUTS_CONFIRM_POLL_MS,
    PAYOUTS_CONFIRM_MAX_POLLS: process.env.PAYOUTS_CONFIRM_MAX_POLLS,
    PAYOUT_METHOD_NAME: process.env.PAYOUT_METHOD_NAME,
    PAYOUT_CONTRACT_ID: process.env.PAYOUT_CONTRACT_ID ?? "C...",
    PAYOUT_SOURCE_ACCOUNT: process.env.PAYOUT_SOURCE_ACCOUNT ?? "G...",
    PAYOUT_HOT_SIGNER_SECRET: process.env.PAYOUT_HOT_SIGNER_SECRET,
    STELLAR_NETWORK_PASSPHRASE:
      process.env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    SOROBAN_RPC_URL: process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
  });

  return {
    liveExecution: parsed.PAYOUTS_LIVE_EXECUTION,
    signWithHotKey: parsed.PAYOUTS_SIGN_WITH_HOT_KEY,
    maxGasStroops: parsed.PAYOUTS_MAX_GAS_STROOPS,
    maxAttempts: parsed.PAYOUTS_MAX_ATTEMPTS,
    confirmPollMs: parsed.PAYOUTS_CONFIRM_POLL_MS,
    confirmMaxPolls: parsed.PAYOUTS_CONFIRM_MAX_POLLS,
    payoutMethodName: parsed.PAYOUT_METHOD_NAME ?? "distribute_winnings",
    payoutContractId: parsed.PAYOUT_CONTRACT_ID,
    sourceAccount: parsed.PAYOUT_SOURCE_ACCOUNT,
    hotSignerSecret: parsed.PAYOUT_HOT_SIGNER_SECRET,
    networkPassphrase: parsed.STELLAR_NETWORK_PASSPHRASE,
    sorobanRpcUrl: parsed.SOROBAN_RPC_URL,
  };
}
