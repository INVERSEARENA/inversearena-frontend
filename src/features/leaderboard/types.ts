// Leaderboard types

export interface Survivor {
  id: string;
  agentId: string; // wallet address (truncated for display)
  rank: number;
  survivalStreak: number;
  totalYield: number; // in USDC
  arenasWon: number;
}

// Pagination state
export interface PaginationState {
  currentPage: number;
  totalPages: number;
  itemsPerPage: number;
  totalItems: number;
}
