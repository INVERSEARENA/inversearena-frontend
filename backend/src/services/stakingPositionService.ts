/**
 * Chain-backed staking position service (#1510).
 *
 * Reconciles a wallet's staking-contract share accounting into a single view:
 * shares, principal-equivalent, accrued rewards, and withdrawable amount —
 * all as exact integer minor units. An RPC failure is reported as
 * `freshness: "unavailable"` with null amounts; it is **never** rendered as a
 * zero balance, because "you have nothing staked" and "we could not read the
 * chain" are different facts.
 *
 * @module
 */

import {
  getOnChainContractVersion,
  readOnChainMinInitialStake,
  readOnChainStakePosition,
  readOnChainStakingTotals,
} from "./onChainReader";
import { hasReadValue, type OnChainReadResult } from "../types/onChainRead";
import {
  stakingPositionReadDuration,
  stakingPositionReadFailuresTotal,
  stakingReconciliationLagSeconds,
} from "../utils/metrics";
import {
  computeAccruedRewards,
  computeWithdrawable,
  resolveStakingConfig,
  StakingNotConfiguredError,
  type StakingConfig,
} from "./stakingPositionMath";

export {
  computeWithdrawable,
  resolveStakingConfig,
  StakingNotConfiguredError,
  type StakingConfig,
} from "./stakingPositionMath";

export type StakingFreshness = "verified" | "stale" | "unavailable";

export interface StakingPositionView {
  wallet: string;
  assetDecimals: number;
  network: string;
  contractVersion: number | null;
  freshness: StakingFreshness;
  /** Ledger the data was observed against, when known. */
  ledger: number | null;
  observedAt: string;
  /** Exact integer minor units, serialised as decimal strings. */
  shares: string | null;
  principalEquivalent: string | null;
  accruedRewards: string | null;
  withdrawable: string | null;
  minInitialStake: string | null;
  totalStaked: string | null;
  totalShares: string | null;
}

export interface StakingPositionServiceDeps {
  config?: StakingConfig;
  now?: () => Date;
}

function stringify(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

export class StakingPositionService {
  private readonly config: StakingConfig;
  private readonly now: () => Date;

  constructor(deps: StakingPositionServiceDeps = {}) {
    this.config = deps.config ?? resolveStakingConfig();
    this.now = deps.now ?? (() => new Date());
  }

  async getPosition(wallet: string): Promise<StakingPositionView> {
    if (!this.config.contractId) {
      throw new StakingNotConfiguredError();
    }
    const contractId = this.config.contractId;
    const started = process.hrtime.bigint();

    const [position, totals] = await Promise.all([
      readOnChainStakePosition(contractId, wallet),
      readOnChainStakingTotals(contractId),
    ]);
    const version = await this.readVersion(contractId);
    const minimum = await readOnChainMinInitialStake(contractId);

    const positionAvailable = hasReadValue(position);
    const totalsAvailable = hasReadValue(totals);

    const outcome: StakingFreshness =
      positionAvailable && totalsAvailable ? "verified" : "unavailable";

    const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000_000;
    stakingPositionReadDuration.observe({ outcome }, Math.max(0, elapsed));

    const observedAt = this.now().toISOString();

    if (!positionAvailable || !totalsAvailable) {
      this.recordFailure(positionAvailable ? totals : position);
      stakingReconciliationLagSeconds.set(-1);
      return {
        wallet,
        assetDecimals: this.config.decimals,
        network: this.config.network,
        contractVersion: version,
        freshness: "unavailable",
        ledger: null,
        observedAt,
        shares: null,
        principalEquivalent: null,
        accruedRewards: null,
        withdrawable: null,
        minInitialStake: hasReadValue(minimum) ? stringify(minimum.value) : null,
        totalStaked: null,
        totalShares: null,
      };
    }

    const shares = position.value.shares;
    const principal = position.value.amount;
    const withdrawable = computeWithdrawable(
      shares,
      totals.value.totalStaked,
      totals.value.totalShares,
    );
    const accrued = computeAccruedRewards(principal, withdrawable);

    stakingReconciliationLagSeconds.set(0);

    return {
      wallet,
      assetDecimals: this.config.decimals,
      network: this.config.network,
      contractVersion: version,
      freshness: outcome,
      ledger: position.provenance.ledgerSequence,
      observedAt,
      shares: stringify(shares),
      principalEquivalent: stringify(principal),
      accruedRewards: stringify(accrued),
      withdrawable: stringify(withdrawable),
      minInitialStake: hasReadValue(minimum) ? stringify(minimum.value) : null,
      totalStaked: stringify(totals.value.totalStaked),
      totalShares: stringify(totals.value.totalShares),
    };
  }

  private async readVersion(contractId: string): Promise<number | null> {
    try {
      return await getOnChainContractVersion(contractId);
    } catch {
      return null;
    }
  }

  private recordFailure(result: OnChainReadResult<unknown>): void {
    const reason = result.outcome === "unavailable" ? result.error.code : "no_value";
    stakingPositionReadFailuresTotal.inc({ reason });
  }
}
