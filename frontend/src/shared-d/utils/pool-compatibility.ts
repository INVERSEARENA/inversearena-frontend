/**
 * Validation and filtering utilities for pool creation compatibility (#1634).
 *
 * Ensures that stake tokens, yield vaults, and oracles configured for a pool
 * match the vault's on-chain configuration before transaction submission.
 */

export interface VaultConfig {
  address: string;
  stakeToken: string;
  oracleContract: string;
}

export type PoolCompatibilityError =
  | "VaultTokenMismatch"
  | "OracleMismatch"
  | "UnsupportedToken"
  | "InvalidVault"
  | "InvalidOracle";

export interface CompatibilityCheckResult {
  compatible: boolean;
  error?: PoolCompatibilityError;
  message?: string;
}

/**
 * Validates whether a proposed pool configuration has matching token, vault, and oracle.
 */
export function checkPoolCompatibility(params: {
  stakeToken: string;
  yieldVault: string;
  oracleContract: string;
  vaultConfig?: VaultConfig;
  supportedTokens?: string[];
  approvedVaults?: string[];
  approvedOracles?: string[];
}): CompatibilityCheckResult {
  if (params.supportedTokens && !params.supportedTokens.includes(params.stakeToken)) {
    return {
      compatible: false,
      error: "UnsupportedToken",
      message: "This token is not supported for pool creation.",
    };
  }
  if (params.approvedVaults && !params.approvedVaults.includes(params.yieldVault)) {
    return {
      compatible: false,
      error: "InvalidVault",
      message: "The specified vault is not approved.",
    };
  }
  if (params.approvedOracles && !params.approvedOracles.includes(params.oracleContract)) {
    return {
      compatible: false,
      error: "InvalidOracle",
      message: "The specified oracle is not approved.",
    };
  }
  if (params.vaultConfig) {
    if (params.vaultConfig.stakeToken !== params.stakeToken) {
      return {
        compatible: false,
        error: "VaultTokenMismatch",
        message: "The selected yield vault does not support this stake token.",
      };
    }
    if (params.vaultConfig.oracleContract !== params.oracleContract) {
      return {
        compatible: false,
        error: "OracleMismatch",
        message: "The selected oracle does not match the yield vault oracle.",
      };
    }
  }
  return { compatible: true };
}

/**
 * Filters a list of vaults to only those compatible with the selected stake token and optional oracle.
 */
export function filterCompatibleVaults<T extends { address: string; stakeToken: string; oracleContract: string }>(
  vaults: T[],
  stakeToken: string,
  oracleContract?: string,
): T[] {
  return vaults.filter((vault) => {
    if (vault.stakeToken !== stakeToken) return false;
    if (oracleContract && vault.oracleContract !== oracleContract) return false;
    return true;
  });
}

/**
 * Returns available currencies that have at least one compatible vault registered.
 */
export function getCompatibleCurrencies(
  availableCurrencies: Array<{ code: string; contractId: string }>,
  vaults: VaultConfig[],
): string[] {
  const supportedTokenIds = new Set(vaults.map((v) => v.stakeToken));
  return availableCurrencies
    .filter((c) => supportedTokenIds.has(c.contractId))
    .map((c) => c.code);
}
