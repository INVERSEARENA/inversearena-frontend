/**
 * Payout batch planner tests (#1620).
 *
 * The simulator is a fake whose resource use grows with batch size, so the
 * tests can place the failure threshold exactly and check that bisection finds
 * the largest batch under the headroom target.
 */

import {
  planPayoutBatches,
  shrinkOnDrift,
  summarizePlan,
  type BatchSimulator,
  type PayoutRecipient,
} from "../payoutBatchPlanner";

const ARENA = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const LIMITS = { cpuInstructions: 1_000_000, memoryBytes: 100_000 };

function recipients(count: number): PayoutRecipient[] {
  return Array.from({ length: count }, (_, i) => ({
    arenaId: ARENA,
    recipient: `G${String(i).padStart(55, "A")}`,
    amount: 10n,
  }));
}

/** Uses `perRecipient` CPU per payout; `base` is fixed overhead. */
function linearSimulator(perRecipientCpu: number, base = 0): {
  simulate: BatchSimulator;
  calls: number[];
} {
  const calls: number[] = [];
  const simulate: BatchSimulator = async (batch) => {
    calls.push(batch.length);
    return {
      ok: true,
      usage: {
        cpuInstructions: base + perRecipientCpu * batch.length,
        memoryBytes: 1_000 * batch.length,
        minResourceFee: BigInt(100 * batch.length),
      },
    };
  };
  return { simulate, calls };
}

describe("planPayoutBatches", () => {
  it("returns no batches for an empty input without simulating", async () => {
    const { simulate, calls } = linearSimulator(1);
    const plan = await planPayoutBatches([], { limits: LIMITS, simulate });
    expect(plan.batches).toEqual([]);
    expect(plan.unplannable).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("takes the whole ceiling in one batch when it already fits", async () => {
    // 50 recipients at 1,000 CPU each = 50,000, under 80% of 1,000,000.
    const { simulate } = linearSimulator(1_000);
    const plan = await planPayoutBatches(recipients(50), { limits: LIMITS, simulate });
    expect(plan.batches.map((b) => b.recipients.length)).toEqual([50]);
  });

  it("bisects to the largest batch under the headroom target", async () => {
    // 80% of 1,000,000 = 800,000. At 20,000 CPU each, 40 fits and 41 does not.
    const { simulate } = linearSimulator(20_000);
    const plan = await planPayoutBatches(recipients(50), { limits: LIMITS, simulate });
    expect(plan.batches[0].recipients.length).toBe(40);
    expect(plan.batches.map((b) => b.recipients.length)).toEqual([40, 10]);
    expect(plan.unplannable).toEqual([]);
  });

  it("respects a custom headroom", async () => {
    // At 50% headroom the target is 500,000: 25 recipients of 20,000 each fit, 26 do not.
    const { simulate } = linearSimulator(20_000);
    const plan = await planPayoutBatches(recipients(30), {
      limits: LIMITS,
      simulate,
      headroom: 0.5,
    });
    expect(plan.batches[0].recipients.length).toBe(25);
  });

  it("treats a simulation error as not fitting and shrinks the batch", async () => {
    // Simulation fails for any batch above 12 recipients.
    const simulate: BatchSimulator = async (batch) =>
      batch.length > 12
        ? { ok: false, error: "exceeded instruction limit" }
        : {
            ok: true,
            usage: { cpuInstructions: 1, memoryBytes: 1, minResourceFee: 1n },
          };
    const plan = await planPayoutBatches(recipients(30), { limits: LIMITS, simulate });
    expect(plan.batches.map((b) => b.recipients.length)).toEqual([12, 12, 6]);
    expect(plan.unplannable).toEqual([]);
  });

  it("skips a recipient that does not fit even alone, and keeps planning", async () => {
    const heavyRecipient = recipients(1)[0];
    const simulate: BatchSimulator = async (batch) => {
      const containsHeavy = batch.some((r) => r.recipient === heavyRecipient.recipient);
      const cpu = containsHeavy ? 2_000_000 : 1_000;
      return {
        ok: true,
        usage: { cpuInstructions: cpu * batch.length, memoryBytes: 1, minResourceFee: 1n },
      };
    };
    const input = [recipients(3)[1], heavyRecipient, recipients(3)[2]];
    const plan = await planPayoutBatches(input, { limits: LIMITS, simulate });
    expect(plan.unplannable).toEqual([heavyRecipient]);
    expect(plan.batches.flatMap((b) => b.recipients)).toHaveLength(2);
  });

  it("uses the maxBatchSize cap, and never exceeds the contract limit of 50", async () => {
    const { simulate, calls } = linearSimulator(1);
    const plan = await planPayoutBatches(recipients(120), {
      limits: LIMITS,
      simulate,
      maxBatchSize: 500,
    });
    expect(Math.max(...plan.batches.map((b) => b.recipients.length))).toBe(50);
    expect(Math.max(...calls)).toBeLessThanOrEqual(50);
  });

  it("rejects an invalid headroom", async () => {
    const { simulate } = linearSimulator(1);
    await expect(
      planPayoutBatches(recipients(1), { limits: LIMITS, simulate, headroom: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      planPayoutBatches(recipients(1), { limits: LIMITS, simulate, headroom: 1.5 }),
    ).rejects.toThrow(RangeError);
  });

  it("keeps every recipient exactly once, in input order", async () => {
    const { simulate } = linearSimulator(30_000);
    const input = recipients(37);
    const plan = await planPayoutBatches(input, { limits: LIMITS, simulate });
    const flattened = plan.batches.flatMap((b) => b.recipients.map((r) => r.recipient));
    expect(flattened).toEqual(input.map((r) => r.recipient));
  });
});

describe("shrinkOnDrift", () => {
  it("returns the first half of a batch that drifted over its limits", () => {
    const batch = recipients(9);
    expect(shrinkOnDrift(batch)?.length).toBe(4);
  });

  it("returns undefined when a single recipient can no longer shrink", () => {
    expect(shrinkOnDrift(recipients(1))).toBeUndefined();
  });
});

describe("summarizePlan", () => {
  it("reports recipients per transaction and fee per recipient", async () => {
    const { simulate } = linearSimulator(20_000);
    const plan = await planPayoutBatches(recipients(50), { limits: LIMITS, simulate });
    const metrics = summarizePlan(plan);
    expect(metrics.transactions).toBe(2);
    expect(metrics.recipients).toBe(50);
    expect(metrics.recipientsPerTransaction).toBe(25);
    // Each recipient is charged 100 stroops in this fake fee model.
    expect(metrics.feePerRecipientStroops).toBe(100);
  });

  it("returns zeros for an empty plan", () => {
    const metrics = summarizePlan({ batches: [], unplannable: [], simulationCount: 0 });
    expect(metrics).toEqual({
      transactions: 0,
      recipients: 0,
      recipientsPerTransaction: 0,
      feePerRecipientStroops: 0,
    });
  });
});
