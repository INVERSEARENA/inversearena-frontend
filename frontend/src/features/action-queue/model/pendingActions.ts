/** Pending player actions shared by dashboard and arena views (#1860). */
export type PendingActionKind = "commit" | "reveal" | "claim";

export interface PendingAction {
  readonly id: string;
  readonly arenaId: string;
  readonly kind: PendingActionKind;
  readonly deadline: number;
  readonly label: string;
}

/** Sorts verified, pending actions by the nearest deadline without mutating input. */
export function sortPendingActions(actions: readonly PendingAction[]): PendingAction[] {
  return [...actions].sort((left, right) => left.deadline - right.deadline || left.id.localeCompare(right.id));
}

/** Returns an urgency tier suitable for an accessible queue badge. */
export function actionUrgency(deadline: number, now = Date.now()): "urgent" | "soon" | "normal" {
  const remaining = deadline - now;
  if (remaining <= 15 * 60 * 1000) return "urgent";
  if (remaining <= 60 * 60 * 1000) return "soon";
  return "normal";
}
