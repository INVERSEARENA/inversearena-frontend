/**
 * Pure staking-position math and configuration (#1510).
 *
 * Kept free of any on-chain/SDK imports so the pro-rata share math and the
 * config resolver can be unit tested in isolation, and so the share formula
 * lives in exactly one place alongside the tests that pin it.
 *
 * @module
 */

import { getStellarConfig } from "../config/stellarConfig";
import { processEnv } from "../config/env";

const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

export interface StakingConfig {
  contractId: string | null;
  decimals: number;
  network: string;
}

export class StakingNotConfiguredError extends Error {
  readonly code = "STAKING_NOT_CONFIGURED";
  constructor() {
    super("The staking contract is not configured (STAKING_CONTRACT_ID is unset)");
    this.name = "StakingNotConfiguredError";
  }
}

/**
 * Resolve staking configuration from the environment. A present-but-malformed
 * contract id is a hard error (mirrors `stellarConfig.ts`): silently treating
 * it as unset would hide a typo as "staking not deployed".
 */
export function resolveStakingConfig(env: NodeJS.ProcessEnv = processEnv): StakingConfig {
  const raw = env.STAKING_CONTRACT_ID?.trim();
  const contractId = raw ? raw : null;
  if (contractId && !CONTRACT_ID_RE.test(contractId)) {
    throw new Error(
      "STAKING_CONTRACT_ID must be a valid Stellar contract id (C...55 base32 chars)",
    );
  }
  const decimalsRaw = env.STAKING_ASSET_DECIMALS?.trim();
  const decimals = decimalsRaw ? Number(decimalsRaw) : 7;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error("STAKING_ASSET_DECIMALS must be an integer in [0, 18]");
  }
  return { contractId, decimals, network: getStellarConfig(env).networkPassphrase };
}

/**
 * Withdrawable amount for a share balance, using the same pro-rata formula the
 * contract uses on `unstake`: `shares * total_staked / total_shares`. Integer
 * division truncates toward zero, matching on-chain behaviour. No floating
 * point is involved.
 *
 * Returns `0n` when the pool has no shares outstanding or the caller has none.
 */
export function computeWithdrawable(
  shares: bigint,
  totalStaked: bigint,
  totalShares: bigint,
): bigint {
  if (totalShares <= 0n || shares <= 0n) return 0n;
  return (shares * totalStaked) / totalShares;
}

/**
 * Accrued rewards are the portion of the withdrawable amount above the
 * staker's tracked principal. Never negative (a lossy pool cannot happen on
 * the contract, but clamping keeps the view honest if it ever did).
 */
export function computeAccruedRewards(principal: bigint, withdrawable: bigint): bigint {
  return withdrawable > principal ? withdrawable - principal : 0n;
}
