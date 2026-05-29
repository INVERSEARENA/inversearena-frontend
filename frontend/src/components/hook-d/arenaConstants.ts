/**
 * Centralized Arena Configuration Constants
 */
import { STELLAR_PLACEHOLDERS, stellarConfig } from "@/lib/stellarConfig";

export const GAME_MECHANICS = {
  MAX_CAPACITY: 1024,
  LOG_BUFFER_SIZE: 50,
  POPULATION_SPLIT: {
    HEADS_FRACTION: 0.55,
    TAILS_FRACTION: 0.45,
  },
} as const;

export const UI_BEHAVIOR = {
  ARENA_POLLING_INTERVAL: 5000,
  COUNTDOWN_INTERVAL: 1000,
  NOTIFICATION_AUTO_HIDE: 3000,
  TELEMETRY_POLL_INTERVAL_MS: Number(process.env.NEXT_PUBLIC_TELEMETRY_POLL_INTERVAL_MS) || 60000,
} as const;

export const STELLAR_NETWORK = {
  PASSPHRASE: stellarConfig.passphrase,
  SOROBAN_RPC_URL: stellarConfig.sorobanRpcUrl,
  HORIZON_URL: stellarConfig.horizonUrl,
  CONTRACTS: {
    FACTORY: stellarConfig.factoryContractId,
    XLM: stellarConfig.xlmContractId,
    USDC: stellarConfig.usdcContractId,
    STAKING_PLACEHOLDER: STELLAR_PLACEHOLDERS.stakingContractId,
  },
} as const;

export const TRANSACTION_CONFIG = {
  BASE_FEE: "100",
  JOIN_FEE: "10000",
  TIMEOUT_SECONDS: 30,
  MAX_RETRIES: 10,
  RETRY_INTERVAL_MS: 2000,
} as const;

export const ARENA_STATES = {
  JOINING: "JOINING",
  ACTIVE: "ACTIVE",
  RESOLVING: "RESOLVING",
  ENDED: "ENDED",
} as const;
