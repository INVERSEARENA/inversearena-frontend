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
