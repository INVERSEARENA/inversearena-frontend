import { Arena, ArenaStatus, ArenaCategory } from '../types';

// Mock arenas data with diverse scenarios
export const mockArenas: Arena[] = [
  {
    id: 'arena-842',
    displayId: 842,
    name: 'Elite Survival Championship',
    description: 'High-stakes elimination game for experienced players only.',
    status: 'active' as ArenaStatus,
    category: 'high-stakes' as ArenaCategory,
    entryFee: 100,
    currentPot: 2400,
    maxPlayers: 25,
    currentPlayers: 24,
    roundDuration: 120,
    currentRound: 3,
    maxRounds: 8,
    createdAt: new Date('2026-01-20T10:30:00Z'),
    startsAt: new Date('2026-01-20T11:00:00Z'),
    endsAt: new Date('2026-01-22T15:00:00Z'),
    lastActivity: new Date('2026-01-22T14:45:00Z'),
    createdBy: 'INV-AGENT-7291',
    featured: true,
    tags: ['elimination', 'high-stakes', 'premium'],
    yieldRate: 5.2,
    rwaProtocol: 'Ondo USDY'
  },
  {
    id: 'arena-103',
    displayId: 103,
    name: 'Lightning Round Arena',
    description: 'Fast-paced 30-second rounds for quick decision makers.',
    status: 'active' as ArenaStatus,
    category: 'fast-rounds' as ArenaCategory,
    entryFee: 25,
    currentPot: 375,
    maxPlayers: 15,
    currentPlayers: 12,
    roundDuration: 30,
    currentRound: 7,
    createdAt: new Date('2026-01-22T13:15:00Z'),
    startsAt: new Date('2026-01-22T13:30:00Z'),
    lastActivity: new Date('2026-01-22T14:55:00Z'),
    createdBy: 'INV-AGENT-4829',
    tags: ['fast', 'quick-rounds', 'intense'],
    yieldRate: 4.8,
    rwaProtocol: 'Stellar USDC'
  },
  {
    id: 'arena-501',
    displayId: 501,
    name: 'Midnight Mayhem',
    description: 'Late-night arena for global players across time zones.',
    status: 'starting' as ArenaStatus,
    category: 'all' as ArenaCategory,
    entryFee: 50,
    currentPot: 450,
    maxPlayers: 20,
    currentPlayers: 9,
    roundDuration: 90,
    currentRound: 0,
    createdAt: new Date('2026-01-22T14:30:00Z'),
    startsAt: new Date('2026-01-22T16:00:00Z'),
    lastActivity: new Date('2026-01-22T15:00:00Z'),
    createdBy: 'INV-AGENT-9184',
    tags: ['global', 'midnight', 'timezone-friendly'],
    yieldRate: 4.5
  },
  {
    id: 'arena-299',
    displayId: 299,
    name: 'Whale Wars',
    description: 'Ultra high-stakes arena for serious players with deep pockets.',
    status: 'active' as ArenaStatus,
    category: 'high-stakes' as ArenaCategory,
    entryFee: 500,
    currentPot: 3500,
    maxPlayers: 10,
    currentPlayers: 7,
    roundDuration: 180,
    currentRound: 2,
    maxRounds: 6,
    createdAt: new Date('2026-01-21T16:00:00Z'),
    startsAt: new Date('2026-01-21T17:00:00Z'),
    endsAt: new Date('2026-01-23T20:00:00Z'),
    lastActivity: new Date('2026-01-22T14:30:00Z'),
    createdBy: 'INV-AGENT-1001',
    featured: true,
    tags: ['whale', 'ultra-high-stakes', 'exclusive'],
    yieldRate: 6.1,
    rwaProtocol: 'Treasury Bills'
  },
  {
    id: 'arena-777',
    displayId: 777,
    name: 'Lucky Sevens Speed Run',
    description: 'Super fast elimination rounds - blink and you\'re out!',
    status: 'active' as ArenaStatus,
    category: 'fast-rounds' as ArenaCategory,
    entryFee: 15,
    currentPot: 210,
    maxPlayers: 14,
    currentPlayers: 11,
    roundDuration: 20,
    currentRound: 5,
    createdAt: new Date('2026-01-22T14:00:00Z'),
    startsAt: new Date('2026-01-22T14:15:00Z'),
    lastActivity: new Date('2026-01-22T14:58:00Z'),
    createdBy: 'INV-AGENT-3377',
    tags: ['speed', 'lucky', 'adrenaline'],
    yieldRate: 3.9
  },
  {
    id: 'arena-156',
    displayId: 156,
    name: 'Beginner\'s Paradise',
    description: 'Perfect arena for new players to learn the ropes.',
    status: 'starting' as ArenaStatus,
    category: 'all' as ArenaCategory,
    entryFee: 10,
    currentPot: 80,
    maxPlayers: 12,
    currentPlayers: 8,
    roundDuration: 60,
    currentRound: 0,
    createdAt: new Date('2026-01-22T15:00:00Z'),
    startsAt: new Date('2026-01-22T16:30:00Z'),
    lastActivity: new Date('2026-01-22T15:00:00Z'),
    createdBy: 'INV-AGENT-5555',
    tags: ['beginner', 'learning', 'friendly'],
    yieldRate: 4.0
  },
  {
    id: 'arena-999',
    displayId: 999,
    name: 'The Gauntlet',
    description: 'Extended survival challenge with maximum rounds.',
    status: 'active' as ArenaStatus,
    category: 'high-stakes' as ArenaCategory,
    entryFee: 200,
    currentPot: 1800,
    maxPlayers: 12,
    currentPlayers: 9,
    roundDuration: 150,
    currentRound: 1,
    maxRounds: 12,
    createdAt: new Date('2026-01-21T09:00:00Z'),
    startsAt: new Date('2026-01-21T10:00:00Z'),
    endsAt: new Date('2026-01-23T22:00:00Z'),
    lastActivity: new Date('2026-01-22T14:20:00Z'),
    createdBy: 'INV-AGENT-8888',
    tags: ['endurance', 'marathon', 'ultimate'],
    yieldRate: 5.8,
    rwaProtocol: 'Ondo USDY'
  },
  {
    id: 'arena-444',
    displayId: 444,
    name: 'Flash Decision Arena',
    description: 'Lightning-fast rounds test your instincts.',
    status: 'completed' as ArenaStatus,
    category: 'fast-rounds' as ArenaCategory,
    entryFee: 30,
    currentPot: 270,
    maxPlayers: 9,
    currentPlayers: 9,
    roundDuration: 25,
    currentRound: 6,
    createdAt: new Date('2026-01-22T12:00:00Z'),
    startsAt: new Date('2026-01-22T12:15:00Z'),
    endsAt: new Date('2026-01-22T13:45:00Z'),
    lastActivity: new Date('2026-01-22T13:45:00Z'),
    createdBy: 'INV-AGENT-2244',
    tags: ['flash', 'instinct', 'completed'],
    yieldRate: 4.2
  }
];

// Featured arena selection
export const featuredArena = mockArenas.find(arena => arena.displayId === 842);

// Helper functions for filtering
export const getArenasByCategory = (arenas: Arena[], category: ArenaCategory): Arena[] => {
  if (category === 'all') {
    return arenas.filter(arena => arena.status !== 'completed');
  }
  return arenas.filter(arena => arena.category === category && arena.status !== 'completed');
};

export const searchArenasByIdOrName = (arenas: Arena[], search: string): Arena[] => {
  if (!search.trim()) return arenas;
  
  const searchTerm = search.toLowerCase().trim();
  
  // Check if search is numeric (for ID search)
  const numericSearch = parseInt(searchTerm.replace('#', ''));
  if (!isNaN(numericSearch)) {
    return arenas.filter(arena => arena.displayId === numericSearch);
  }
  
  // Text search in name and description
  return arenas.filter(arena => 
    arena.name.toLowerCase().includes(searchTerm) ||
    arena.description.toLowerCase().includes(searchTerm) ||
    arena.tags.some(tag => tag.toLowerCase().includes(searchTerm))
  );
};

export const getActiveArenas = (arenas: Arena[]): Arena[] => {
  return arenas.filter(arena => 
    arena.status === 'active' || arena.status === 'starting'
  );
};

export const sortArenasByActivity = (arenas: Arena[]): Arena[] => {
  return arenas.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
};