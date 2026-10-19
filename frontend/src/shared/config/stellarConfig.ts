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
  NEXT_PUBLIC_RWA_VAULT_CONTRACT_ID: z.string().trim().min(3).optional(),
  NEXT_PUBLIC_ORACLE_CONTRACT_ID: z.string().trim().min(3).optional(),
  /**
   * Classic credit-asset issuers (#1487), by asset code.
   *
   * A `changeTrust` is keyed by the *exact* `(code, issuer)` pair, so there is
   * no way to derive an issuer from a contract id and no safe default: a wrong
   * issuer produces a trustline to an asset the user does not hold and burns a
   * signature. #1487 rules "automatically choosing asset issuers" out of scope,
   * so each issuer is declared explicitly here and deployment-specific.
   *
   * Deliberately optional: importing this module must stay non-throwing (#1134),
   * and an unset issuer must degrade to a clear "unconfigured" preflight state
   * rather than crashing the app or silently allowing an ungated signature.
   */
  NEXT_PUBLIC_USDC_ISSUER: z.string().trim().min(1).optional(),
  NEXT_PUBLIC_EURC_ISSUER: z.string().trim().min(1).optional(),
});

export interface StellarConfig {
  networkName: "testnet" | "mainnet";
  network: Networks;
  passphrase: string;
  sorobanRpcUrl: string;
  horizonUrl: string;
  factoryContractId: string;
  usdcContractId: string;
  xlmContractId: string;
  stakingContractId: string | undefined;
  rwaVaultContractId: string | undefined;
  oracleContractId: string | undefined;
  /**
   * Classic credit-asset issuers keyed by asset code, e.g. `{ USDC: "G..." }`.
   * Codes with no entry here have no known issuer on this network.
   */
  assetIssuers: Readonly<Record<string, string>>;
}

function buildStellarConfig():
  | { config: StellarConfig; error: null }
  | { config: null; error: string } {
  const result = StellarEnvSchema.safeParse({
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
    NEXT_PUBLIC_RWA_VAULT_CONTRACT_ID:
      process.env.NEXT_PUBLIC_RWA_VAULT_CONTRACT_ID,
    NEXT_PUBLIC_ORACLE_CONTRACT_ID:
      process.env.NEXT_PUBLIC_ORACLE_CONTRACT_ID,
    NEXT_PUBLIC_USDC_ISSUER: process.env.NEXT_PUBLIC_USDC_ISSUER,
    NEXT_PUBLIC_EURC_ISSUER: process.env.NEXT_PUBLIC_EURC_ISSUER,
  });

  if (!result.success) {
    const missing = [
      ...new Set(result.error.issues.map((issue) => issue.path.join("."))),
    ];
    return {
      config: null,
      error: `Missing or invalid Stellar environment variable(s): ${missing.join(", ")}`,
    };
  }

  const env = result.data;
  const isMainnet = env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet";

  // Only set keys for issuers that were actually provided, so
  // `assetIssuers["USDC"]` is `undefined` (not `""`) when unconfigured.
  const assetIssuers: Record<string, string> = {};
  if (env.NEXT_PUBLIC_USDC_ISSUER) assetIssuers.USDC = env.NEXT_PUBLIC_USDC_ISSUER;
  if (env.NEXT_PUBLIC_EURC_ISSUER) assetIssuers.EURC = env.NEXT_PUBLIC_EURC_ISSUER;

  return {
    config: {
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
      rwaVaultContractId: env.NEXT_PUBLIC_RWA_VAULT_CONTRACT_ID,
      oracleContractId: env.NEXT_PUBLIC_ORACLE_CONTRACT_ID,
      assetIssuers,
    },
    error: null,
  };
}

const { config: parsedStellarConfig, error: parsedStellarConfigError } =
  buildStellarConfig();

/**
 * True once all required Soroban env vars are present and valid. Safe to
 * read from any component (e.g. a dev-mode setup banner) without triggering
 * the lazy throw below — checking this never touches `stellarConfig`.
 */
export const isStellarConfigured = parsedStellarConfig !== null;

/**
 * Present only when `isStellarConfigured` is false: a human-readable summary
 * of what's missing/invalid, for the dev-mode setup banner.
 */
export const stellarConfigError = parsedStellarConfigError;

/**
 * Issue #1134 — previously this module called `.parse()` (throwing) at
 * import time, so ANY missing env var crashed the entire Next.js app,
 * including unrelated pages (home, profile, leaderboard) that never touch
 * Stellar config at all. `stellarConfig` now always resolves successfully
 * at import time; when required env vars are missing, it's a Proxy that
 * throws lazily, only once some component actually reads a property off it
 * to perform a Soroban-specific operation. Every existing call site
 * (`stellarConfig.sorobanRpcUrl`, etc.) keeps working unchanged.
 */
export const stellarConfig: StellarConfig =
  parsedStellarConfig ??
  new Proxy({} as StellarConfig, {
    get(_target, prop) {
      throw new Error(
        `Stellar is not configured: cannot read "${String(prop)}" from stellarConfig. ${parsedStellarConfigError}`,
      );
    },
  });

export const STELLAR_PLACEHOLDERS = {
  stakingContractId: "CD...",
} as const;
