// --- Game Lifecycle ---

export type ArenaV2Status =
  | "PENDING"
  | "JOINING"
  | "ACTIVE"
  | "RESOLVING"
  | "ENDED"
  | "CANCELLED";

// --- Round Types ---

export type RoundPhase = "WAITING" | "CHOOSING" | "RESOLVING" | "RESOLVED";

export interface RoundResult {
  round: number;
  choice: "HEADS" | "TAILS" | null;
  outcome: "HEADS" | "TAILS";
  majorityChoice: "HEADS" | "TAILS";
  eliminatedCount: number;
}

// --- Player Types ---

export type PlayerStatus = "JOINING" | "READY" | "ALIVE" | "ELIMINATED";

export interface PlayerEntry {
  wallet: string;
  status: PlayerStatus;
  joinedAt: number;
  currentRound: number;
}

// --- Elimination Event ---

export interface EliminationEvent {
  arenaId: string;
  round: number;
  walletAddress: string;
  reason: "MINORITY" | "TIMEOUT" | "FORFEIT";
  timestamp: number;
}

// --- Yield Types ---

export interface YieldSnapshot {
  principal: number;
  accruedYield: number;
  apy: number;
  lastUpdatedAt: number;
  surgeMultiplier: number;
}

// --- Transaction Types ---

export type ArenaTxType = "JOIN" | "SUBMIT_CHOICE" | "CLAIM" | "WITHDRAW";

export type ArenaTxStatus =
  | "IDLE"
  | "SIGNING"
  | "SUBMITTING"
  | "SUCCESS"
  | "FAILED";
