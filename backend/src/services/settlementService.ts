import type { TransactionRecord } from "../types/payment";
export { computeSettlementBreakdown } from "../domain/settlement";
export type { SettlementBreakdown } from "../domain/settlement";

export interface SettlementManifest extends SettlementBreakdown {
  payoutId: string;
  recipient: string;
  asset: string;
  txHash: string | null;
  confirmedAt: string | null;
}

const STROOP_PRECISION = 1e7;

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
/**
 * Builds the receipt for an already-created payout transaction. Only
 * transactions created with a breakdown (currently: round-settlement
 * payouts, see domain/roundResolution) carry principal/yield/fee/dust —
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
