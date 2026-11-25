/** Shared UI choice configuration. On-chain three-option support is pending. */
export type ArenaChoiceOption = "Heads" | "Tails" | "Third";
export function getChoiceOptions(optionCount: 2 | 3): readonly ArenaChoiceOption[] {
  return optionCount === 3 ? ["Heads", "Tails", "Third"] : ["Heads", "Tails"];
}
/** Non-zero, least-chosen options tie; zero-choice options cannot win. */
export function leastChosenOptions(counts: readonly number[]): number[] {
  if (counts.length !== 2 && counts.length !== 3) throw new Error("Only 2 or 3 choices supported");
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) throw new Error("Invalid tally");
  const positive = counts.filter((count) => count > 0);
  if (!positive.length) return [];
  const minimum = Math.min(...positive);
  return counts.flatMap((count, index) => count === minimum ? [index] : []);
}
