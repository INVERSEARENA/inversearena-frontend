import { 
  AgentIdentity, 
  ProfileStats, 
  MyArena, 
  HistoryEntry, 
  ArenaStatus,
  HistoryAction
} from '../types';

// Mock agent identity
export const mockAgentIdentity: AgentIdentity = {
  id: 'INV-AGENT-8742',
  rank: 47,
  level: 12,
  survivalTime: 38420 // ~10.6 hours in seconds
};

// Mock profile stats
export const mockProfileStats: ProfileStats = {
  totalStake: 2847.50,
  yieldEarned: 1247.83,
  arenasCreated: 8
};

// Mock my arenas data
export const mockMyArenas: MyArena[] = [
  {
    id: 'arena-001',
    name: 'High Stakes Survival',
    status: 'live' as ArenaStatus,
    entryFee: 50,
    totalPot: 1250,
    playersCount: 18,
    maxPlayers: 25,
    createdAt: new Date('2026-01-20T14:30:00Z'),
    endsAt: new Date('2026-01-22T18:00:00Z'),
    myPosition: 3
  },
  {
    id: 'arena-002',
    name: 'Quick Round Arena',
    status: 'live' as ArenaStatus,
    entryFee: 25,
    totalPot: 375,
    playersCount: 12,
    maxPlayers: 15,
    createdAt: new Date('2026-01-21T09:15:00Z'),
    endsAt: new Date('2026-01-22T12:00:00Z'),
    myPosition: 7
  },
  {
    id: 'arena-003',
    name: 'Elite Champions',
    status: 'completed' as ArenaStatus,
    entryFee: 100,
    totalPot: 2000,
    playersCount: 20,
    maxPlayers: 20,
    createdAt: new Date('2026-01-18T16:00:00Z'),
    endsAt: new Date('2026-01-19T20:30:00Z'),
    myPosition: 1 // Won this one!
  },
  {
    id: 'arena-004',
    name: 'Beginner Friendly',
    status: 'completed' as ArenaStatus,
    entryFee: 10,
    totalPot: 150,
    playersCount: 15,
    maxPlayers: 15,
    createdAt: new Date('2026-01-17T11:00:00Z'),
    endsAt: new Date('2026-01-17T15:45:00Z'),
    myPosition: 8
  },
  {
    id: 'arena-005',
    name: 'Weekend Warrior',
    status: 'cancelled' as ArenaStatus,
    entryFee: 30,
    totalPot: 90,
    playersCount: 3,
    maxPlayers: 10,
    createdAt: new Date('2026-01-15T19:00:00Z')
  }
];

// Mock history data
export const mockHistory: HistoryEntry[] = [
  {
    id: 'hist-001',
    action: 'arena_won' as HistoryAction,
    description: 'Won Elite Champions arena',
    amount: 2000,
    timestamp: new Date('2026-01-19T20:30:00Z'),
    arenaId: 'arena-003'
  },
  {
    id: 'hist-002',
    action: 'yield_earned' as HistoryAction,
    description: 'Yield generated from arena stake',
    amount: 15.75,
    timestamp: new Date('2026-01-21T12:00:00Z')
  },
  {
    id: 'hist-003',
    action: 'arena_created' as HistoryAction,
    description: 'Created Quick Round Arena',
    timestamp: new Date('2026-01-21T09:15:00Z'),
    arenaId: 'arena-002'
  },
  {
    id: 'hist-004',
    action: 'arena_joined' as HistoryAction,
    description: 'Joined High Stakes Survival',
    amount: -50,
    timestamp: new Date('2026-01-20T14:35:00Z'),
    arenaId: 'arena-001'
  },
  {
    id: 'hist-005',
    action: 'yield_earned' as HistoryAction,
    description: 'Daily yield from RWA protocol',
    amount: 8.42,
    timestamp: new Date('2026-01-20T08:00:00Z')
  },
  {
    id: 'hist-006',
    action: 'arena_eliminated' as HistoryAction,
    description: 'Eliminated from Beginner Friendly (Round 3)',
    timestamp: new Date('2026-01-17T14:20:00Z'),
    arenaId: 'arena-004'
  },
  {
    id: 'hist-007',
    action: 'arena_created' as HistoryAction,
    description: 'Created Elite Champions arena',
    timestamp: new Date('2026-01-18T16:00:00Z'),
    arenaId: 'arena-003'
  },
  {
    id: 'hist-008',
    action: 'yield_earned' as HistoryAction,
    description: 'Weekly yield accumulation',
    amount: 23.18,
    timestamp: new Date('2026-01-18T00:00:00Z')
  }
];

// Helper function to filter live arenas
export const getLiveArenas = (arenas: MyArena[]): MyArena[] => {
  return arenas.filter(arena => arena.status === 'live');
};

// Helper function to get recent history (last 10 entries)
export const getRecentHistory = (history: HistoryEntry[]): HistoryEntry[] => {
  return history
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, 10);
};