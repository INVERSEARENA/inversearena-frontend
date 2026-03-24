import type { xdr } from "@stellar/stellar-sdk";
import type { ArenaState, UserState } from "@/shared-d/types/contract-state";
import {
  extractBoolFromScVal,
  extractI128FromScVal,
  extractU32FromScVal,
  stroopsToDisplayAmount,
} from "@/shared-d/utils/stellar-scval-extract";

export function parseArenaStateFromScVal(stateData: xdr.ScVal): ArenaState {
  return {
    survivors: extractU32FromScVal(stateData, "survivors_count") ?? 0,
    capacity: extractU32FromScVal(stateData, "max_capacity") ?? 0,
    round: extractU32FromScVal(stateData, "round_number") ?? 0,
    stakes: extractI128FromScVal(stateData, "current_stake") ?? 0n,
    payouts: extractI128FromScVal(stateData, "potential_payout") ?? 0n,
  };
}

export function parseUserStateFromScVal(userData: xdr.ScVal): UserState {
  return {
    active: extractBoolFromScVal(userData, "is_active") ?? false,
    won: extractBoolFromScVal(userData, "has_won") ?? false,
  };
}

export function buildArenaDisplayState(arenaState: ArenaState): Pick<
  import("@/shared-d/types/contract-state").FetchArenaStateResult,
  | "survivorsCount"
  | "maxCapacity"
  | "currentStake"
  | "potentialPayout"
  | "roundNumber"
  | "currentStakeStroops"
  | "potentialPayoutStroops"
> {
  return {
    survivorsCount: arenaState.survivors,
    maxCapacity: arenaState.capacity,
    currentStake: stroopsToDisplayAmount(arenaState.stakes),
    potentialPayout: stroopsToDisplayAmount(arenaState.payouts),
    roundNumber: arenaState.round,
    currentStakeStroops: arenaState.stakes,
    potentialPayoutStroops: arenaState.payouts,
  };
}
