/** Client-side validation for sponsor prize boosts before signing (#1862). */
export interface PrizeBoostPolicy {
  readonly minimum: bigint;
  readonly maximum: bigint;
  readonly mode: "host-only" | "open";
}

export function validatePrizeBoost(
  amount: bigint,
  policy: PrizeBoostPolicy,
  wallet: string,
  host: string,
  arenaState: "Open" | "Active" | "Finished" | "Cancelled",
  round: number,
): string | null {
  if (arenaState !== "Open" || round !== 0) return "Prize boosts are accepted only before the arena starts.";
  if (policy.mode === "host-only" && wallet !== host) return "Only the arena host may add a prize boost.";
  if (amount < policy.minimum || amount > policy.maximum) {
    return `Prize boost must be between ${policy.minimum} and ${policy.maximum} stroops.`;
  }
  return null;
}
