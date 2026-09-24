import type { TransactionRecord } from "../types/payment";

export interface SettlementBreakdown {
  /** The winner's own stake plus every eliminated player's forfeited stake. */
  principal: number;
  /** The oracle-yield portion earned on the eliminated stake pool. */
  yieldAmount: number;
  /** A bps cut of yieldAmount only — never principal. */
  platformFee: number;
  /** The fractional remainder the integer stroop-precision fee math discards. */
  dust: number;
  /** principal + yieldAmount - platformFee - dust; what the winner actually receives. */
  netPayout: number;
}

export interface SettlementManifest extends SettlementBreakdown {
  payoutId: string;
  recipient: string;
  asset: string;
  txHash: string | null;
  confirmedAt: string | null;
}

const DEFAULT_PLATFORM_FEE_BPS = 0;
const STROOP_PRECISION = 1e7;

function platformFeeBps(): number {
  const env = Number(process.env.PLATFORM_FEE_BPS);
  return Number.isFinite(env) && env >= 0 && env <= 10_000 ? env : DEFAULT_PLATFORM_FEE_BPS;
}

/**
 * DESIGN NOTE (#1407)
 *
 * Splits a round payout into its reconcilable parts. principal + yieldAmount
 * always equals netPayout + platformFee + dust — the identity this module's
 * tests exist to hold.
 *
 * PLATFORM_FEE_BPS defaults to 0, matching the contract's current behavior
 * (platform_fee_bps is stored and settable on-chain but not yet deducted
 * from any payout — see contract/arena/src/lib.rs's update_platform_fee doc
 * comment). At the default, netPayout is byte-for-byte the same value
 * roundService already computed before this feature existed — this is a
 * reporting/reconciliation feature, not a change to what anyone gets paid,
 * unless an operator explicitly opts in by setting PLATFORM_FEE_BPS.
 */
export function computeSettlementBreakdown(input: {
  winnerStake: number;
  eliminatedStake: number;
  oracleYieldPercent: number;
}): SettlementBreakdown {
  const { winnerStake, eliminatedStake, oracleYieldPercent } = input;

  if (winnerStake < 0 || eliminatedStake < 0) {
    throw new Error("winnerStake and eliminatedStake must not be negative");
  }
  if (!Number.isFinite(oracleYieldPercent) || oracleYieldPercent < 0) {
    throw new Error("oracleYieldPercent must be a non-negative finite number");
  }

  const principal = winnerStake + eliminatedStake;
  const yieldAmount = eliminatedStake * (oracleYieldPercent / 100);

  const bps = platformFeeBps();
  const exactFee = (yieldAmount * bps) / 10_000;
  const platformFee = Math.floor(exactFee * STROOP_PRECISION) / STROOP_PRECISION;
  const dust = Math.max(0, exactFee - platformFee);
  const netPayout = principal + yieldAmount - platformFee - dust;

  return { principal, yieldAmount, platformFee, dust, netPayout };
}

/**
 * Builds the receipt for an already-created payout transaction. Only
 * transactions created with a breakdown (currently: round-settlement
 * payouts, see roundService.computePayouts) carry principal/yield/fee/dust —
 * an admin-created ad-hoc payout has none of that context, so its receipt
 * reports the lump amount as netPayout with the rest left null rather than
 * fabricating a split that was never computed.
 */
export function buildSettlementManifest(transaction: TransactionRecord): SettlementManifest {
  const hasBreakdown =
    transaction.principal !== undefined &&
    transaction.principal !== null &&
    transaction.yieldAmount !== undefined &&
    transaction.yieldAmount !== null;

  const displayAmount = Number(transaction.amountStroops) / STROOP_PRECISION;

  return {
    payoutId: transaction.payoutId,
    recipient: transaction.destinationAccount,
    asset: transaction.asset,
    txHash: transaction.txHash ?? null,
    confirmedAt: transaction.confirmedAt ? new Date(transaction.confirmedAt).toISOString() : null,
    principal: hasBreakdown ? transaction.principal! : displayAmount,
    yieldAmount: hasBreakdown ? transaction.yieldAmount! : 0,
    platformFee: hasBreakdown ? (transaction.platformFee ?? 0) : 0,
    dust: hasBreakdown ? (transaction.dust ?? 0) : 0,
    netPayout: displayAmount,
  };
}

function csvEscape(value: string | number): string {
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Renders a settlement manifest as a one-row CSV, for the downloadable receipt endpoint. */
export function toReceiptCsv(manifest: SettlementManifest): string {
  const headers = [
    "payoutId",
    "recipient",
    "asset",
    "principal",
    "yieldAmount",
    "platformFee",
    "dust",
    "netPayout",
    "txHash",
    "confirmedAt",
  ];
  const row = [
    manifest.payoutId,
    manifest.recipient,
    manifest.asset,
    manifest.principal,
    manifest.yieldAmount,
    manifest.platformFee,
    manifest.dust,
    manifest.netPayout,
    manifest.txHash ?? "",
    manifest.confirmedAt ?? "",
  ];
  return `${headers.join(",")}\n${row.map(csvEscape).join(",")}\n`;
}
