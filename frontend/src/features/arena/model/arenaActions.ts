import type { ArenaActions, PlayerStatus } from "@/shared/lib/stellar/contract-state";

export const NO_ARENA_ACTIONS: ArenaActions = Object.freeze({
  canCommit: false,
  canReveal: false,
  canClaim: false,
  canRefund: false,
});

/**
 * Which player transactions the arena contract would accept right now,
 * derived only from `get_player_status` (#1582). Each rule mirrors the
 * contract guard it predicts:
 *
 * - commit: `submit_commitment` needs an active player before the commit
 *   deadline; offered once per round because a second commit would replace
 *   the first and orphan its locally stored salt
 * - reveal: `reveal_choice` needs a commitment, no prior reveal, and the deadline passed
 * - claim:  `claim` needs the recorded winner of a `Finished` arena
 * - refund: `claim_refund` needs a joined player of a `Cancelled` arena, once
 *
 * An unknown status (`null`) enables nothing rather than guessing.
 */
export function deriveArenaActions(status: PlayerStatus | null): ArenaActions {
  if (!status) return NO_ARENA_ACTIONS;
  return {
    canCommit: status.phase === "Commit" && status.active && !status.committed,
    canReveal:
      status.phase === "Reveal" && status.active && status.committed && !status.revealed,
    canClaim: status.phase === "Finished" && status.winner,
    canRefund: status.phase === "Cancelled" && status.joined && !status.refundClaimed,
  };
}
