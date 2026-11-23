/**
 * Pool creation compatibility between stake token, yield vault and oracle (#1634).
 *
 * A yield vault holds exactly one stake token and accrues yield from exactly
 * one oracle. The factory's `create_pool` rejects a pool whose `stake_token`
 * differs from the vault's (`VaultTokenMismatch`) or whose `oracle_contract`
 * differs from the vault's (`OracleMismatch`). These helpers apply the same
 * rule in the client, so the form only offers combinations the factory will
 * accept instead of failing at signing time.
 */
import { scValToNative, type xdr } from "@stellar/stellar-sdk";
import type { Currency } from "@/shared/lib/form-validation";

/** Mirrors the RWA adapter's `VaultConfig` contract type. */
export type VaultConfig = {
  stakeToken: string;
  oracle: string;
};

export type CurrencyTokenIds = Record<Currency, string>;

/** Decode the return value of the RWA adapter's `config()` read. */
export function parseVaultConfigFromScVal(retval: xdr.ScVal): VaultConfig {
  const native = scValToNative(retval) as { stake_token?: unknown; oracle?: unknown };
  if (typeof native?.stake_token !== "string" || typeof native?.oracle !== "string") {
    throw new Error("Vault config read returned an unexpected shape");
  }
  return { stakeToken: native.stake_token, oracle: native.oracle };
}

/**
 * The currencies a pool can be created in against `vault`.
 *
 * Only the currency whose token contract is the vault's stake token
 * qualifies. If the app is configured with an oracle other than the vault's,
 * no currency qualifies: every pool would be refused with `OracleMismatch`.
 */
export function compatibleCurrencies(
  vault: VaultConfig,
  tokenIds: CurrencyTokenIds,
  configuredOracle: string,
): Currency[] {
  if (vault.oracle !== configuredOracle) return [];
  return (Object.keys(tokenIds) as Currency[]).filter(
    (currency) => tokenIds[currency] === vault.stakeToken,
  );
}

/**
 * Throw if a pool in `currency` would be rejected by the factory for a
 * vault/token/oracle mismatch. Called just before building the transaction,
 * so a stale form selection can never reach the wallet.
 */
export function assertPoolCompatible(
  vault: VaultConfig,
  currency: Currency,
  tokenIds: CurrencyTokenIds,
  configuredOracle: string,
): void {
  if (vault.oracle !== configuredOracle) {
    throw new Error(
      "The configured oracle does not match the yield vault's oracle; pools cannot be created until the deployment config is fixed.",
    );
  }
  if (tokenIds[currency] !== vault.stakeToken) {
    throw new Error(`The yield vault does not hold ${currency}; choose a supported currency.`);
  }
}
