import type { ArenaDomainEvent } from "@/shared-d/types/arenaTypes";

export interface ArenaState {
  survivors: number;
  capacity: number;
  round: number;
  stakes: bigint;
  payouts: bigint;
}

export interface UserState {
  active: boolean;
  won: boolean;
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
