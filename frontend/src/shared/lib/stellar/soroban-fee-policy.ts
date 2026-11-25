/**
 * Pure Soroban fee policy. All values are stroops (not XLM).
 * Resource fee comes from RPC simulation; inclusion fee comes from RPC fee stats.
 * The protocol's transaction builder applies resource fees separately during
 * assembly: do not add them twice when supplying the base inclusion fee.
 */
export type SorobanAction = "commit" | "reveal" | "create" | "other";
export interface FeeStatsLike {
  sorobanInclusionFee?: { p50?: string; p90?: string };
  inclusionFee?: { p50?: string; p90?: string };
}
export interface FeePolicyOptions {
  action: SorobanAction;
  simulatedResourceFee: string | number | bigint;
  stats?: FeeStatsLike | null;
  nearDeadline?: boolean;
  headroomBps?: Partial<Record<SorobanAction, number>>;
  fallbackInclusionFee?: bigint;
}
export interface FeeQuote {
  inclusionFee: bigint;
  resourceFee: bigint;
  resourceFeeWithHeadroom: bigint;
  totalFee: bigint;
  usedFallback: boolean;
  percentile: "p50" | "p90";
}
const DEFAULT_HEADROOM_BPS: Record<SorobanAction, number> = {
  commit: 1500, reveal: 2500, create: 2000, other: 1500,
};
function nonnegativeInteger(value: string | number | bigint): bigint {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error("INVALID_FEE_VALUE");
  }
  const s = String(value);
  if (!/^\d+$/.test(s)) throw new Error("INVALID_FEE_VALUE");
  return BigInt(s);
}
export function calculateSorobanFee(options: FeePolicyOptions): FeeQuote {
  const resourceFee = nonnegativeInteger(options.simulatedResourceFee);
  const bps = options.headroomBps?.[options.action] ?? DEFAULT_HEADROOM_BPS[options.action];
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 100_000) {
    throw new Error("INVALID_FEE_HEADROOM");
  }
  const percentile = options.action === "reveal" && options.nearDeadline ? "p90" : "p50";
  const stat = (options.stats?.sorobanInclusionFee ?? options.stats?.inclusionFee)?.[percentile];
  let inclusionFee: bigint;
  let usedFallback = false;
  try {
    if (stat == null) throw new Error("MISSING_FEE_STATS");
    inclusionFee = nonnegativeInteger(stat);
  } catch {
    inclusionFee = options.fallbackInclusionFee ?? 100n;
    usedFallback = true;
  }
  if (inclusionFee < 100n) inclusionFee = 100n;
  const resourceFeeWithHeadroom = (resourceFee * BigInt(10_000 + bps) + 9_999n) / 10_000n;
  return {
    inclusionFee, resourceFee, resourceFeeWithHeadroom,
    totalFee: inclusionFee + resourceFeeWithHeadroom,
    usedFallback, percentile,
  };
}
