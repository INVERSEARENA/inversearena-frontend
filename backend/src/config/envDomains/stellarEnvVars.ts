import { z } from "zod";
import type { EnvVarSpec } from "../envSpec";
import { accountId, contractId, csv, decimal, flag, int, isoTimestamp, kid, rateLimit, rotation, secretSeed, text, url } from "../envSpec";

export const stellarEnvVars = {
  SOROBAN_RPC_URL: {
    section: "Soroban / Stellar",
    description: "Soroban RPC endpoint.",
    example: "https://soroban-testnet.stellar.org",
    required: true,
    schema: url,
  },
  STELLAR_NETWORK_PASSPHRASE: {
    section: "Soroban / Stellar",
    description: "Network passphrase.",
    example: "Test SDF Network ; September 2015",
    required: true,
    schema: z.string().min(3),
  },
  RPC_URL_ALLOWLIST: {
    section: "Soroban / Stellar",
    description: "Comma-separated hostnames outbound RPC may reach (#1447). Empty allows all.",
    schema: csv(z.string().regex(/^[a-z0-9.-]+$/i), "hostnames"),
  },
  RPC_MAX_RESPONSE_BYTES: {
    section: "Soroban / Stellar",
    description: "Largest RPC response accepted, in bytes (#1447).",
    default: "1048576",
    schema: int(1),
  },
  ARENA_FACTORY_CONTRACT_ID: {
    section: "Soroban / Stellar",
    description: "Factory contract. POST /api/arenas checks the submitted txHash invoked create_pool on it.",
    required: true,
    schema: contractId,
  },
  PAYOUT_CONTRACT_ID: { section: "Soroban / Stellar", description: "Payout contract.", required: true, schema: contractId },
  PAYOUT_SOURCE_ACCOUNT: {
    section: "Soroban / Stellar",
    description: "Account that submits payout transactions.",
    required: true,
    schema: accountId,
  },
  PAYOUT_METHOD_NAME: {
    section: "Soroban / Stellar",
    description: "Payout contract method to invoke.",
    example: "distribute_winnings",
    schema: text,
  },
  STAKE_TOKEN_CONTRACT_ID: {
    section: "Soroban / Stellar",
    description: "Stake token contract the deployment is configured with. Creator templates are checked against it (#1689).",
    schema: contractId,
  },
  RWA_VAULT_CONTRACT_ID: {
    section: "Soroban / Stellar",
    description: "Yield vault contract the deployment is configured with. Creator templates are checked against it (#1689).",
    schema: contractId,
  },
  ORACLE_CONTRACT_ID: {
    section: "Soroban / Stellar",
    description: "Oracle contract the deployment is configured with. Creator templates are checked against it (#1688, #1689).",
    schema: contractId,
  },
  STAKING_CONTRACT_ID: {
    section: "Soroban / Stellar",
    description: "Staking contract. Staking endpoints report not-configured when unset.",
    schema: contractId,
  },
  STAKING_ASSET_DECIMALS: {
    section: "Soroban / Stellar",
    description: "Decimals of the staked asset.",
    default: "7",
    schema: int(0, 18),
  },
  ASSET_ISSUERS: {
    section: "Soroban / Stellar",
    description:
      "Classic credit-asset issuers as comma-separated CODE:ISSUER pairs (#1489). Must match the frontend's NEXT_PUBLIC_*_ISSUER. XLM is native and must not be listed.",
    example: "",
    schema: csv(z.string().regex(/^[A-Z][A-Z0-9]{0,4}:G[A-Z2-7]{55}$/), "CODE:ISSUER pairs"),
  },
  ARENA_ADMIN_SECRET: {
    section: "Soroban / Stellar",
    description: "Secret seed that signs arena admin transactions (resolve_round). Server-side only.",
    secret: true,
    schema: secretSeed,
  },
  ARENA_SIM_SOURCE_SECRET: {
    section: "Soroban / Stellar",
    description: "Secret seed of the source account used to simulate read-only contract calls.",
    secret: true,
    schema: secretSeed,
  },
  ROUND_CONFIRM_POLL_MS: {
    section: "Soroban / Stellar",
    description: "Base delay between resolve_round confirmation polls, with exponential backoff (#1193).",
    default: "2500",
    schema: int(1),
  },
  ROUND_CONFIRM_MAX_POLLS: {
    section: "Soroban / Stellar",
    description: "Confirmation polls before giving up.",
    default: "20",
    schema: int(1),
  }
} satisfies Record<string, EnvVarSpec>;
