import type { ArenaDomainEvent } from "@/shared-d/types/arenaTypes";

export type ArenaStateStatus = "open" | "round_active" | "resolving" | "finished" | "cancelled" | "settled";

export interface ArenaState {
  id: string;
  status: ArenaStateStatus;
  survivorsCount: number;
  maxCapacity: number;
  currentRound: number;
  isUserIn: boolean;
  hasWon: boolean;
  currentStake: number;
  potentialPayout: number;
  claimReady: boolean;
  entryFee: number;
  playerCount: number;
  // Contract-specific fields
  survivors: number;
  capacity: number;
  round: number;
  stakes: bigint;
  payouts: bigint;
  commitDeadline: number | null;
  revealDeadline: number | null;
}

export interface UserState {
  active: boolean;
  won: boolean;
}

export interface ContractArenaState {
  survivors: number;
  capacity: number;
  round: number;
  stakes: bigint;
  payouts: bigint;
}

export interface ContractUserState {
  active: boolean;
  won: boolean;
}

export interface ArenaStateFromContract {
  arenaId: string;
  contractArenaState: ContractArenaState;
  contractUserState: ContractUserState;
  gameState: number | null;
  entryFee: number | null;
  playerCount: number;
  commitDeadline: number | null;
  revealDeadline: number | null;
}

export interface FetchArenaStateResult {
  arenaId: string;
  arenaState: ArenaState;
  userState: UserState;
  survivorsCount: number;
  maxCapacity: number;
  isUserIn: boolean;
  hasWon: boolean;
  currentStake: number;
  potentialPayout: number;
  roundNumber: number;
  currentStakeStroops: bigint;
  potentialPayoutStroops: bigint;
}

export type ArenaContractEvent = ArenaDomainEvent;
