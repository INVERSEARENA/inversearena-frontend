import { 
  Arena, 
  ArenaFilter, 
  ArenaSearchParams 
} from '../types';
import { 
  mockArenas, 
  featuredArena,
  getArenasByCategory,
  searchArenasByIdOrName,
  getActiveArenas,
  sortArenasByActivity
} from './mockArenas';

// Simulated API delay for realistic loading states
const simulateApiDelay = (ms: number = 600): Promise<void> => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

// Repository interface for future API integration
export interface ArenasRepository {
  getArenas(params?: ArenaSearchParams): Promise<Arena[]>;
  getFeaturedArena(): Promise<Arena | undefined>;
  getArenaById(id: string): Promise<Arena | undefined>;
  getArenaByDisplayId(displayId: number): Promise<Arena | undefined>;
}

// Mock repository implementation
class MockArenasRepository implements ArenasRepository {
  async getArenas(params?: ArenaSearchParams): Promise<Arena[]> {
    await simulateApiDelay(500);
    
    let arenas = [...mockArenas];
    
    // Apply category filter
    if (params?.filter && params.filter !== 'all') {
      arenas = getArenasByCategory(arenas, params.filter);
    } else {
      // For 'all' filter, exclude completed arenas
      arenas = getActiveArenas(arenas);
    }
    
    // Apply search
    if (params?.search) {
      arenas = searchArenasByIdOrName(arenas, params.search);
    }
    
    // Sort by activity (most recent first)
    arenas = sortArenasByActivity(arenas);
    
    return arenas;
  }

  async getFeaturedArena(): Promise<Arena | undefined> {
    await simulateApiDelay(300);
    return featuredArena;
  }

  async getArenaById(id: string): Promise<Arena | undefined> {
    await simulateApiDelay(200);
    return mockArenas.find(arena => arena.id === id);
  }

  async getArenaByDisplayId(displayId: number): Promise<Arena | undefined> {
    await simulateApiDelay(200);
    return mockArenas.find(arena => arena.displayId === displayId);
  }
}

// Repository instance
export const arenasRepository = new MockArenasRepository();

// Helper functions for data transformation
export const formatPotValue = (amount: number): string => {
  if (amount >= 1000000) {
    return `$${(amount / 1000000).toFixed(1)}M`;
  }
  if (amount >= 1000) {
    return `$${(amount / 1000).toFixed(1)}K`;
  }
  return `$${amount.toFixed(0)}`;
};

export const formatTimeRemaining = (endsAt: Date): string => {
  const now = new Date();
  const diff = endsAt.getTime() - now.getTime();
  
  if (diff <= 0) return 'Ended';
  
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  
  return `${minutes}m`;
};

export const getArenaStatusColor = (status: string): string => {
  switch (status) {
    case 'active':
      return 'text-green-400';
    case 'starting':
      return 'text-yellow-400';
    case 'completed':
      return 'text-gray-400';
    case 'cancelled':
      return 'text-red-400';
    default:
      return 'text-gray-400';
  }
};

export const getPlayerCountStatus = (current: number, max: number): 'full' | 'filling' | 'low' => {
  const ratio = current / max;
  if (ratio >= 0.9) return 'full';
  if (ratio >= 0.5) return 'filling';
  return 'low';
};

// Error handling utilities
export class ArenasRepositoryError extends Error {
  constructor(
    message: string,
    public code: string,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'ArenasRepositoryError';
  }
}

export const handleRepositoryError = (error: unknown): ArenasRepositoryError => {
  if (error instanceof ArenasRepositoryError) {
    return error;
  }
  
  if (error instanceof Error) {
    return new ArenasRepositoryError(
      'Failed to fetch arenas data',
      'FETCH_ERROR',
      error
    );
  }
  
  return new ArenasRepositoryError(
    'Unknown error occurred',
    'UNKNOWN_ERROR'
  );
};

// Validation utilities
export const validateSearchQuery = (search: string): boolean => {
  // Allow alphanumeric, spaces, and # symbol
  return /^[a-zA-Z0-9\s#]*$/.test(search) && search.length <= 50;
};

export const normalizeSearchQuery = (search: string): string => {
  return search.trim().toLowerCase();
};