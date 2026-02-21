// Arena status types
export type ArenaStatus = 'active' | 'starting' | 'completed' | 'cancelled';

// Arena difficulty/type categories
export type ArenaCategory = 'all' | 'high-stakes' | 'fast-rounds';

// Arena round phases
export type ArenaPhase = 'waiting' | 'round-active' | 'round-ended' | 'finished';

// Arena data structure
export interface Arena {
  id: string;
  displayId: number; // Numeric ID for search (e.g., 842)
  name: string;
  description: string;
  status: ArenaStatus;
  category: ArenaCategory;
  
  // Game mechanics
  entryFee: number;
  currentPot: number;
  maxPlayers: number;
  currentPlayers: number;
  roundDuration: number; // seconds per round
  currentRound: number;
  maxRounds?: number;
  
  // Timestamps
  createdAt: Date;
  startsAt?: Date;
  endsAt?: Date;
  lastActivity: Date;
  
  // Additional metadata
  createdBy: string;
  featured?: boolean;
  tags: string[];
  
  // Yield information
  yieldRate?: number; // APY percentage
  rwaProtocol?: string;
}

// Filter options for arenas
export type ArenaFilter = 'all' | 'high-stakes' | 'fast-rounds';

// Search parameters
export interface ArenaSearchParams {
  filter: ArenaFilter;
  search: string;
}

// Hook return types
export interface UseArenasData {
  arenas: Arena[];
  featuredArena?: Arena;
  status: 'idle' | 'loading' | 'success' | 'error';
  error?: string;
  totalCount: number;
  filteredCount: number;
}

// Hook options
export interface UseArenasOptions {
  filter?: ArenaFilter;
  search?: string;
  includeCompleted?: boolean;
  limit?: number;
}