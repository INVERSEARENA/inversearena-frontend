/** Pure tournament advancement rules; no network or chain side effects. */
export type QualifierResult = {
  arenaId: string;
  status: "settled" | "cancelled" | "pending";
  winners: string[];
};
export type AdvancementResult = {
  advancing: string[];
  pendingArenas: string[];
  cancelledArenas: string[];
  requiresTiebreak: string[];
};
/** Never advance an unresolved or tied qualifier. Stable, unique addresses only. */
export function calculateAdvancement(results: readonly QualifierResult[]): AdvancementResult {
  const advancing = new Set<string>();
  const pendingArenas: string[] = [];
  const cancelledArenas: string[] = [];
  const requiresTiebreak: string[] = [];
  for (const result of results) {
    if (result.status === "cancelled") { cancelledArenas.push(result.arenaId); continue; }
    if (result.status === "pending") { pendingArenas.push(result.arenaId); continue; }
    const winners = [...new Set(result.winners.filter(Boolean))];
    if (winners.length !== 1) { requiresTiebreak.push(result.arenaId); continue; }
    advancing.add(winners[0]);
  }
  return { advancing: [...advancing], pendingArenas, cancelledArenas, requiresTiebreak };
}
/** A qualified player forfeits the next stage when the deadline has passed without joining. */
export function isNoShow(invited: boolean, joined: boolean, deadlineMs: number, nowMs: number): boolean {
  return invited && !joined && Number.isFinite(deadlineMs) && nowMs > deadlineMs;
}
