/**
 * Centralized Arena Configuration Constants
 */

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
} as const;

export const STELLAR_NETWORK = {
  PASSPHRASE:
    process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ||
    "Test SDF Network ; September 2015",
  SOROBAN_RPC_URL:
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
    "https://soroban-testnet.stellar.org",
  HORIZON_URL:
    process.env.NEXT_PUBLIC_HORIZON_URL ||
    "https://horizon-testnet.stellar.org",
  CONTRACTS: {
    FACTORY: process.env.NEXT_PUBLIC_FACTORY_CONTRACT_ID || "CB...",
    XLM: "CAS3J7GYLGXMF6TDJBXBGMELNUPVCGXIZ68TZE6GTVASJ63Y32KXVY77",
    USDC: process.env.NEXT_PUBLIC_USDC_CONTRACT_ID || "CC...",
    STAKING_PLACEHOLDER: "CD...",
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
