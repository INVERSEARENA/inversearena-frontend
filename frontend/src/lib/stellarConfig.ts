import { Networks } from "@creit-tech/stellar-wallets-kit";
import { z } from "zod";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const DEFAULT_XLM_CONTRACT_ID =
  "CAS3J7GYLGXMF6TDJBXBGMELNUPVCGXIZ68TZE6GTVASJ63Y32KXVY77";

const StellarEnvSchema = z.object({
  NEXT_PUBLIC_STELLAR_NETWORK: z
    .enum(["testnet", "mainnet"])
    .default("testnet"),
  NEXT_PUBLIC_SOROBAN_RPC_URL: z.string().trim().url(),
  NEXT_PUBLIC_HORIZON_URL: z.string().trim().url(),
  NEXT_PUBLIC_FACTORY_CONTRACT_ID: z.string().trim().min(3),
  NEXT_PUBLIC_USDC_CONTRACT_ID: z.string().trim().min(3),
  NEXT_PUBLIC_XLM_CONTRACT_ID: z.string().trim().min(3).optional(),
  NEXT_PUBLIC_STAKING_CONTRACT_ID: z.string().trim().min(3).optional(),
  NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE: z.string().trim().min(3).optional(),
});

const env = StellarEnvSchema.parse({
  NEXT_PUBLIC_STELLAR_NETWORK:
    process.env.NEXT_PUBLIC_STELLAR_NETWORK?.toLowerCase(),
  NEXT_PUBLIC_SOROBAN_RPC_URL: process.env.NEXT_PUBLIC_SOROBAN_RPC_URL,
  NEXT_PUBLIC_HORIZON_URL: process.env.NEXT_PUBLIC_HORIZON_URL,
  NEXT_PUBLIC_FACTORY_CONTRACT_ID:
    process.env.NEXT_PUBLIC_FACTORY_CONTRACT_ID,
  NEXT_PUBLIC_USDC_CONTRACT_ID: process.env.NEXT_PUBLIC_USDC_CONTRACT_ID,
  NEXT_PUBLIC_XLM_CONTRACT_ID: process.env.NEXT_PUBLIC_XLM_CONTRACT_ID,
  NEXT_PUBLIC_STAKING_CONTRACT_ID:
    process.env.NEXT_PUBLIC_STAKING_CONTRACT_ID,
  NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE:
    process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE,
});

const isMainnet = env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet";

export const stellarConfig = {
  networkName: env.NEXT_PUBLIC_STELLAR_NETWORK,
  network: isMainnet ? Networks.PUBLIC : Networks.TESTNET,
  passphrase:
    env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ??
    (isMainnet ? MAINNET_PASSPHRASE : TESTNET_PASSPHRASE),
  sorobanRpcUrl: env.NEXT_PUBLIC_SOROBAN_RPC_URL.replace(/\/+$/, ""),
  horizonUrl: env.NEXT_PUBLIC_HORIZON_URL.replace(/\/+$/, ""),
  factoryContractId: env.NEXT_PUBLIC_FACTORY_CONTRACT_ID,
  usdcContractId: env.NEXT_PUBLIC_USDC_CONTRACT_ID,
  xlmContractId: env.NEXT_PUBLIC_XLM_CONTRACT_ID ?? DEFAULT_XLM_CONTRACT_ID,
  stakingContractId: env.NEXT_PUBLIC_STAKING_CONTRACT_ID,
} as const;

export const STELLAR_PLACEHOLDERS = {
  stakingContractId: "CD...",
} as const;
