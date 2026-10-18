import { z } from "zod";

export const MIN_CAPACITY = 10;
export const MAX_CAPACITY = 1000;
export const MIN_STAKE = 10;

export type RoundSpeed = "30S" | "1M" | "5M";

export const poolSchema = z.object({
  stakeAmount: z.string().refine(
    (val) => {
      const num = parseFloat(val);
      return !isNaN(num) && num > 0;
    },
    { message: "Stake amount must be a positive number" }
  ),
  currency: z.enum(["USDC", "XLM"]),
  roundSpeed: z.enum(["30S", "1M", "5M"]),
  arenaCapacity: z.number().int().min(MIN_CAPACITY).max(MAX_CAPACITY),
});

/**
 * Current shape version for the persisted pool-creation draft (#1405).
 * Bump this whenever poolDraftSchema's fields change in a way that isn't
 * backward compatible, so loadPoolDraft() can tell an old, incompatible
 * draft apart from a current one instead of trusting stale field shapes.
 */
export const POOL_DRAFT_VERSION = 1;

/**
 * Unlike poolSchema (which validates the fully-typed, submission-ready
 * form), the draft schema validates what's safe to persist mid-edit:
 * arenaCapacity as a plain number without the min/max clamp (the modal
 * already clamps it via the +/- steppers, and a relaxed bound here means a
 * future capacity-range change doesn't strand an otherwise-valid draft).
 */
export const poolDraftSchema = z.object({
  version: z.literal(POOL_DRAFT_VERSION),
  stakeAmountInput: z.string(),
  currency: z.enum(["USDC", "XLM"]),
  roundSpeed: z.enum(["30S", "1M", "5M"]),
  arenaCapacity: z.number().int().positive(),
  savedAt: z.number().int().nonnegative(),
});

export type PoolDraft = z.infer<typeof poolDraftSchema>;
