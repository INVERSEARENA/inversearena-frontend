export interface SettlementBreakdown {
  principal: number;
  yieldAmount: number;
  platformFee: number;
  dust: number;
  netPayout: number;
}

const DEFAULT_PLATFORM_FEE_BPS = 0;
const STROOP_PRECISION = 1e7;

function platformFeeBps(): number {
  const env = Number(process.env.PLATFORM_FEE_BPS);
  return Number.isFinite(env) && env >= 0 && env <= 10_000 ? env : DEFAULT_PLATFORM_FEE_BPS;
}

/** Pure calculation of the round's principal, yield, fee, and payout. */
export function computeSettlementBreakdown(input: {
  winnerStake: number;
  eliminatedStake: number;
  oracleYieldPercent: number;
}): SettlementBreakdown {
  const { winnerStake, eliminatedStake, oracleYieldPercent } = input;
  if (winnerStake < 0 || eliminatedStake < 0) {
    throw new Error('winnerStake and eliminatedStake must not be negative');
  }
  if (!Number.isFinite(oracleYieldPercent) || oracleYieldPercent < 0) {
    throw new Error('oracleYieldPercent must be a non-negative finite number');
  }

  const principal = winnerStake + eliminatedStake;
  const yieldAmount = eliminatedStake * (oracleYieldPercent / 100);
  const exactFee = (yieldAmount * platformFeeBps()) / 10_000;
  const platformFee = Math.floor(exactFee * STROOP_PRECISION) / STROOP_PRECISION;
  const dust = Math.max(0, exactFee - platformFee);
  return {
    principal,
    yieldAmount,
    platformFee,
    dust,
    netPayout: principal + yieldAmount - platformFee - dust,
  };
}
