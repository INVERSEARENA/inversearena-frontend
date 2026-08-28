export interface ArenaStats {
  arenaId: string;
  arenaName: string;
  currentPot: number;
  playerCount: number;
  maxPlayers: number;
  survivorCount: number;
  currentRound: number;
  entryFee: number;
  stakeToken: string;
  joinDeadline: string | null;
  yieldAccrued: number;
  status: string;
  lastUpdated: string;
}

export interface ArenaParticipant {
  id: string;
  walletAddress: string;
  // null while the round that contains this choice is still OPEN — a
  // player's heads/tails pick must not be visible to other callers until
  // the round closes, or a caller could pick their own choice accordingly
  // (see #1212).
  choice: "heads" | "tails" | null;
  stake: number;
  status: "READY" | "ACTIVE" | "ELIMINATED";
  roundNumber: number;
  joinedAt: string;
}

export interface CreateArenaInput {
  entryFee: number;
  maxPlayers: number;
  joinDeadline: string;
  stakeToken: string;
  name: string;
}

export interface ArenaCreationResult {
  id: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export type ArenaStreamEventType =
  | "snapshot"
  | "round_resolved"
  | "player_eliminated"
  | "game_finished";

export interface ArenaStreamEvent {
  type: ArenaStreamEventType;
  arenaId: string;
  payload: Record<string, unknown>;
  sequence: number;
  createdAt: string;
}
