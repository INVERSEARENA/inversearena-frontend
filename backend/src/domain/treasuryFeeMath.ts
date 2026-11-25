/**
 * Pure treasury fee-reconciliation math (#1511).
 *
 * No I/O, no Prisma, no RPC — everything here is a deterministic function of
 * its arguments so it can be unit-tested exhaustively and reused identically
 * by the ingestion service and any future replay/backfill tooling. Exact
 * integer (atomic-unit / stroop) math throughout — never floating point —
 * per the issue's "versioned protocol configuration and exact integer math"
 * acceptance criterion.
 */

export type ReconciliationStatus = "pending" | "balanced" | "discrepant";

export type DiscrepancyType =
  | "missing_transfer"
  | "unexpected_transfer"
  | "amount_mismatch"
  | "destination_mismatch"
  | "unfinalized_ledger";

/**
 * The protocol platform fee implied by a round's on-chain-verified yield
 * amount, at a given fee-bps rate. Floor division (matches Soroban's own
 * integer division semantics for `i128` arithmetic) — any fractional
 * remainder is protocol dust, not a reconciliation error.
 */
export function computeExpectedPlatformFee(yieldAmountAtomic: bigint, feeBps: number): bigint {
  if (yieldAmountAtomic < 0n) {
    throw new Error("yieldAmountAtomic must not be negative");
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new Error("feeBps must be an integer in [0, 10000]");
  }
  return (yieldAmountAtomic * BigInt(feeBps)) / 10_000n;
}

export interface ActualTransfer {
  amountAtomic: bigint;
  destination: string;
  txHash: string;
}

export interface ReconciliationInput {
  expectedAmountAtomic: bigint;
  /** Null when no treasury destination is configured yet — see `treasuryConfig.ts`. */
  expectedDestination: string | null;
  /** Null when no matching transfer has been found (yet, or ever). */
  actualTransfer: ActualTransfer | null;
  /** False while the source event is within the configured finality grace window. */
  ledgerFinalized: boolean;
}

export interface ReconciliationResult {
  status: ReconciliationStatus;
  discrepancyType: DiscrepancyType | null;
}

/**
 * Classify a fee record's reconciliation outcome. Order of checks matters:
 * an unfinalized ledger is checked first (nothing else can be concluded yet,
 * regardless of what's been observed so far), then the zero-fee case (an
 * "unexpected transfer" against a zero expectation is still worth flagging),
 * then the standard missing/amount/destination checks.
 */
export function classifyReconciliation(input: ReconciliationInput): ReconciliationResult {
  const { expectedAmountAtomic, expectedDestination, actualTransfer, ledgerFinalized } = input;

  if (!ledgerFinalized) {
    return { status: "pending", discrepancyType: "unfinalized_ledger" };
  }

  if (expectedAmountAtomic === 0n) {
    if (actualTransfer && actualTransfer.amountAtomic > 0n) {
      return { status: "discrepant", discrepancyType: "unexpected_transfer" };
    }
    return { status: "balanced", discrepancyType: null };
  }

  if (!actualTransfer) {
    return { status: "discrepant", discrepancyType: "missing_transfer" };
  }

  if (actualTransfer.amountAtomic !== expectedAmountAtomic) {
    return { status: "discrepant", discrepancyType: "amount_mismatch" };
  }

  if (expectedDestination && actualTransfer.destination !== expectedDestination) {
    return { status: "discrepant", discrepancyType: "destination_mismatch" };
  }

  return { status: "balanced", discrepancyType: null };
}

/**
 * Whether an event at `ledgerClosedAt` has cleared the finality grace
 * window as of `now` — see `treasuryConfig.ts`'s `finalityGraceSeconds` and
 * the "late events / reorgs" edge case.
 */
export function isLedgerFinalized(ledgerClosedAt: Date, now: Date, finalityGraceSeconds: number): boolean {
  return now.getTime() - ledgerClosedAt.getTime() >= finalityGraceSeconds * 1000;
}
