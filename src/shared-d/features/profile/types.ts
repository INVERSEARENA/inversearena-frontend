// Agent identity information
export interface AgentIdentity {
  id: string;
  rank: number;
  level: number;
  survivalTime: number; // in seconds
}

// Stats card data
export interface ProfileStats {
  totalStake: number;
  yieldEarned: number;
  arenasCreated: number;
}

// Arena status types
export type ArenaStatus = 'live' | 'completed' | 'cancelled';

// My Arena data structure
export interface MyArena {
  id: string;
  name: string;
  status: ArenaStatus;
  entryFee: number;
  totalPot: number;
  playersCount: number;
  maxPlayers: number;
  createdAt: Date;
  endsAt?: Date;
  myPosition?: number;
}

// History entry types
export type HistoryAction = 'arena_created' | 'arena_joined' | 'arena_won' | 'arena_eliminated' | 'yield_earned';

export interface HistoryEntry {
  id: string;
  action: HistoryAction;
  description: string;
  amount?: number;
  timestamp: Date;
  arenaId?: string;
}

// Filter options
export type MyArenasFilter = 'all' | 'live';

// Hook return types
export interface UseProfileData {
  profile: {
    identity: AgentIdentity;
    stats: ProfileStats;
  };
  myArenas: MyArena[];
  history: HistoryEntry[];
  status: 'idle' | 'loading' | 'success' | 'error';
  error?: string;
}

// Hook options
export interface UseProfileOptions {
  address?: string; // Optional wallet address for future API integration
  myArenasFilter?: MyArenasFilter;
}