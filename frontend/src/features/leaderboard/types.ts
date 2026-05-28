// Leaderboard types

export type RankMovement = "up" | "down" | "same";

export interface Survivor {
  id: string;
  agentId: string; // wallet address (truncated for display)
  rank: number;
  survivalStreak: number;
  totalYield: number; // in USDC
  arenasWon: number;
  /** Rank change since the previous snapshot, when known (#662). */
  rankMovement?: RankMovement;
}

// Pagination state
export interface PaginationState {
  currentPage: number;
  totalPages: number;
  itemsPerPage: number;
  totalItems: number;
}
