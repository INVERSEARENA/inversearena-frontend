import { z } from "zod";

const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

const StellarEnvSchema = z.object({
  SOROBAN_RPC_URL: z.string().url(),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(3),
});

export type StellarConfig = {
  sorobanRpcUrl: string;
  networkPassphrase: string;
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
  });

  return {
    sorobanRpcUrl: parsed.SOROBAN_RPC_URL,
    networkPassphrase: parsed.STELLAR_NETWORK_PASSPHRASE,
  };
}
