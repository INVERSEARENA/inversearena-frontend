export interface ArenaStats {
  arenaId: string;
  currentPot: number;
  playerCount: number;
  survivorCount: number;
  currentRound: number;
  entryFee: number;
  yieldAccrued: number;
  status: string;
  lastUpdated: string;
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
