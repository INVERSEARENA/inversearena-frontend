/**
 * Simulation-driven payout batch sizing (#1620).
 *
 * `distribute_batch` in `contract/payout` accepts at most `MAX_BATCH_SIZE`
 * recipients, but a fixed cap ignores real resource usage: a SAC transfer to a
 * new account costs more than one to an existing trustline. A fixed batch
 * either fails simulation near the limits or leaves capacity unused, which
 * multiplies transactions and fees.
 *
 * This planner sizes each batch by simulating candidates and bisecting to the
 * largest batch whose simulated resource use stays within a headroom target
 * (for example 80% of the limits). The simulator is injected, so the planner
 * has no network dependency and can be tested with a fake.
 *
 * @module
 */

/** Largest batch the payout contract accepts (`contract/payout` `MAX_BATCH_SIZE`). */
export const PAYOUT_MAX_BATCH_SIZE = 50;

/** Fraction of each resource limit a batch may use. */
export const DEFAULT_HEADROOM = 0.8;

export interface PayoutRecipient {
  arenaId: string;
  recipient: string;
  amount: bigint;
}

export interface ResourceUsage {
  cpuInstructions: number;
  memoryBytes: number;
  minResourceFee: bigint;
}

export interface BatchSimulation {
  /** False when simulation itself failed, for example it exceeded a limit. */
  ok: boolean;
  usage?: ResourceUsage;
  error?: string;
}

export interface ResourceLimits {
  cpuInstructions: number;
  memoryBytes: number;
}

export type BatchSimulator = (batch: readonly PayoutRecipient[]) => Promise<BatchSimulation>;

export interface PlanOptions {
  limits: ResourceLimits;
  simulate: BatchSimulator;
  /** Fraction of each limit a batch may use. Defaults to {@link DEFAULT_HEADROOM}. */
  headroom?: number;
  /** Hard cap on batch size. Defaults to {@link PAYOUT_MAX_BATCH_SIZE}. */
  maxBatchSize?: number;
}

export interface PlannedBatch {
  recipients: PayoutRecipient[];
  usage: ResourceUsage;
}

export interface PayoutBatchPlan {
  batches: PlannedBatch[];
  /** Recipients no batch could carry, even alone, within the headroom target. */
  unplannable: PayoutRecipient[];
  /** Simulator calls made while planning. */
  simulationCount: number;
}

function fitsWithin(usage: ResourceUsage, limits: ResourceLimits, headroom: number): boolean {
  return (
    usage.cpuInstructions <= limits.cpuInstructions * headroom &&
    usage.memoryBytes <= limits.memoryBytes * headroom
  );
}

function validateOptions(options: PlanOptions): { headroom: number; maxBatchSize: number } {
  const headroom = options.headroom ?? DEFAULT_HEADROOM;
  const maxBatchSize = options.maxBatchSize ?? PAYOUT_MAX_BATCH_SIZE;
  if (!(headroom > 0 && headroom <= 1)) {
    throw new RangeError(`headroom must be in (0, 1], got ${headroom}`);
  }
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1) {
    throw new RangeError(`maxBatchSize must be a positive integer, got ${maxBatchSize}`);
  }
  return { headroom, maxBatchSize: Math.min(maxBatchSize, PAYOUT_MAX_BATCH_SIZE) };
}

/**
 * Plans payout batches by simulation.
 *
 * For each batch, the planner tests the largest candidate size first. If that
 * does not fit, it bisects between a known-fitting size and a known-failing
 * size. A simulation error counts as "does not fit", so a batch that trips a
 * limit shrinks instead of aborting the plan.
 *
 * Recipients are kept in input order. A recipient that does not fit even alone
 * is returned in `unplannable` and skipped, so one oversized payout cannot
 * block the rest.
 */
export async function planPayoutBatches(
  recipients: readonly PayoutRecipient[],
  options: PlanOptions,
): Promise<PayoutBatchPlan> {
  const { headroom, maxBatchSize } = validateOptions(options);
  const batches: PlannedBatch[] = [];
  const unplannable: PayoutRecipient[] = [];
  let simulationCount = 0;

  // Simulates the first `size` pending recipients; returns usage if it fits.
  const trial = async (pending: readonly PayoutRecipient[], size: number) => {
    simulationCount += 1;
    const result = await options.simulate(pending.slice(0, size));
    if (!result.ok || !result.usage) return undefined;
    return fitsWithin(result.usage, options.limits, headroom) ? result.usage : undefined;
  };

  let pending = [...recipients];
  while (pending.length > 0) {
    const ceiling = Math.min(maxBatchSize, pending.length);

    // Fast path: the whole ceiling fits.
    let bestSize = 0;
    let bestUsage: ResourceUsage | undefined;
    const full = await trial(pending, ceiling);
    if (full) {
      bestSize = ceiling;
      bestUsage = full;
    } else {
      // Bisect: `low` always fits (or is 0), `high` never fits.
      let low = 0;
      let high = ceiling;
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        const usage = await trial(pending, mid);
        if (usage) {
          low = mid;
          bestUsage = usage;
        } else {
          high = mid;
        }
      }
      bestSize = low;
    }

    if (bestSize === 0 || !bestUsage) {
      unplannable.push(pending[0]);
      pending = pending.slice(1);
      continue;
    }

    batches.push({ recipients: pending.slice(0, bestSize), usage: bestUsage });
    pending = pending.slice(bestSize);
  }

  return { batches, unplannable, simulationCount };
}

/**
 * Halves a batch that no longer fits at submit time. Simulation drift can
 * push a batch over its limits between planning and submission, so the caller
 * retries with the first half. Returns `undefined` when the batch cannot shrink.
 */
export function shrinkOnDrift(batch: readonly PayoutRecipient[]): PayoutRecipient[] | undefined {
  if (batch.length <= 1) return undefined;
  return batch.slice(0, Math.floor(batch.length / 2));
}

export interface PlanMetrics {
  transactions: number;
  recipients: number;
  /** Mean recipients per transaction, the number the planner is meant to raise. */
  recipientsPerTransaction: number;
  /** Total minimum resource fee divided by recipients, in stroops. */
  feePerRecipientStroops: number;
}

/** Summarises a plan for the recipients-per-transaction and fee-per-recipient metrics. */
export function summarizePlan(plan: PayoutBatchPlan): PlanMetrics {
  const transactions = plan.batches.length;
  const recipients = plan.batches.reduce((sum, b) => sum + b.recipients.length, 0);
  const totalFee = plan.batches.reduce((sum, b) => sum + b.usage.minResourceFee, 0n);
  return {
    transactions,
    recipients,
    recipientsPerTransaction: transactions === 0 ? 0 : recipients / transactions,
    feePerRecipientStroops: recipients === 0 ? 0 : Number(totalFee) / recipients,
  };
}
