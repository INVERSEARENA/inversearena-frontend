import { z } from "zod";

const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

const StellarEnvSchema = z.object({
  SOROBAN_RPC_URL: z.string().url(),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(3),
  // On-chain transaction confirmation polling for resolveRound (#1193)
  ROUND_CONFIRM_POLL_MS: z
    .string()
    .optional()
    .transform((v) => Number(v ?? "2500"))
    .pipe(z.number().int().positive()),
  ROUND_CONFIRM_MAX_POLLS: z
    .string()
    .optional()
    .transform((v) => Number(v ?? "20"))
    .pipe(z.number().int().positive()),
});

export type StellarConfig = {
  sorobanRpcUrl: string;
  networkPassphrase: string;
  roundConfirmPollMs: number;
  roundConfirmMaxPolls: number;
};

export function getStellarConfig(
  env: NodeJS.ProcessEnv = process.env,
): StellarConfig {
  const allowTestDefaults = env.NODE_ENV === "test";
  const parsed = StellarEnvSchema.parse({
    SOROBAN_RPC_URL:
      env.SOROBAN_RPC_URL ?? (allowTestDefaults ? TESTNET_RPC_URL : undefined),
    STELLAR_NETWORK_PASSPHRASE:
      env.STELLAR_NETWORK_PASSPHRASE ??
      (allowTestDefaults ? TESTNET_PASSPHRASE : undefined),
    ROUND_CONFIRM_POLL_MS: env.ROUND_CONFIRM_POLL_MS,
    ROUND_CONFIRM_MAX_POLLS: env.ROUND_CONFIRM_MAX_POLLS,
  });

  return {
    sorobanRpcUrl: parsed.SOROBAN_RPC_URL,
    networkPassphrase: parsed.STELLAR_NETWORK_PASSPHRASE,
    roundConfirmPollMs: parsed.ROUND_CONFIRM_POLL_MS,
    roundConfirmMaxPolls: parsed.ROUND_CONFIRM_MAX_POLLS,
  };
}
