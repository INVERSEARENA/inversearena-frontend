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

// ─── Round outcome proof bundle (#1394) ─────────────────────────────────────
//
// Frontend mirror of `backend/src/types/round.ts`'s `RoundProofBundle` family.
// The frontend and backend are separate packages with no shared types module,
// so this is intentionally kept structurally identical rather than imported —
// see `docs/round-outcome-proof-bundle.md` for the compatibility contract
// between the two copies (bump both in lockstep on a breaking shape change).

/** Schema version of the proof bundle payload this client understands. */
export const ROUND_PROOF_BUNDLE_VERSION = 1 as const;

export interface ProofBundlePlayerChoice {
  userId: string;
  choice: "heads" | "tails";
}

export interface ProofBundleTally {
  heads: number;
  tails: number;
}

export interface ProofBundleNetwork {
  /** Stellar network passphrase the bundle was assembled against. */
  passphrase: string;
  /** Soroban contract id (C...) of the arena this round belongs to. */
  arenaContractId: string;
}

export interface RoundProofBundle {
  version: typeof ROUND_PROOF_BUNDLE_VERSION;
  roundId: string;
  arenaId: string;
  roundNumber: number;
  network: ProofBundleNetwork;
  playerChoices: ProofBundlePlayerChoice[];
  allActivePlayerIds: string[];
  tally: ProofBundleTally;
  eliminatedPlayers: string[];
  survivors: string[];
  checksum: string;
  generatedAt: string;
}
