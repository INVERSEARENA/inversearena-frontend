import { 
  AgentIdentity, 
  ProfileStats, 
  MyArena, 
  HistoryEntry, 
  MyArenasFilter 
} from '../types';
import { 
  mockAgentIdentity, 
  mockProfileStats, 
  mockMyArenas, 
  mockHistory,
  getLiveArenas,
  getRecentHistory
} from './mockProfile';

// Simulated API delay for realistic loading states
const simulateApiDelay = (ms: number = 800): Promise<void> => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

// Repository interface for future API integration
export interface ProfileRepository {
  getAgentIdentity(address?: string): Promise<AgentIdentity>;
  getProfileStats(address?: string): Promise<ProfileStats>;
  getMyArenas(address?: string, filter?: MyArenasFilter): Promise<MyArena[]>;
  getHistory(address?: string): Promise<HistoryEntry[]>;
}

// Mock repository implementation
class MockProfileRepository implements ProfileRepository {
  async getAgentIdentity(address?: string): Promise<AgentIdentity> {
    await simulateApiDelay(600);
    
    // In a real implementation, this would fetch based on address
    // For now, return mock data with slight variations if address is provided
    if (address) {
      return {
        ...mockAgentIdentity,
        id: `INV-${address.slice(-6).toUpperCase()}`
      };
    }
    
    return mockAgentIdentity;
  }

  async getProfileStats(address?: string): Promise<ProfileStats> {
    await simulateApiDelay(500);
    
    // Simulate address-based variations
    if (address) {
      const variation = address.length % 100;
      return {
        totalStake: mockProfileStats.totalStake + variation,
        yieldEarned: mockProfileStats.yieldEarned + (variation * 0.5),
        arenasCreated: mockProfileStats.arenasCreated + Math.floor(variation / 10)
      };
    }
    
    return mockProfileStats;
  }

  async getMyArenas(address?: string, filter: MyArenasFilter = 'all'): Promise<MyArena[]> {
    await simulateApiDelay(700);
    
    let arenas = mockMyArenas;
    
    // Apply filter
    if (filter === 'live') {
      arenas = getLiveArenas(arenas);
    }
    
    // In real implementation, would filter by address
    return arenas;
  }

  async getHistory(address?: string): Promise<HistoryEntry[]> {
    await simulateApiDelay(400);
    
    // Return recent history, sorted by timestamp
    return getRecentHistory(mockHistory);
  }
}

// Repository instance
export const profileRepository = new MockProfileRepository();

// Helper functions for data transformation
export const transformArenaStatus = (status: string) => {
  switch (status.toLowerCase()) {
    case 'live':
      return 'live';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'completed';
  }
};

export const formatSurvivalTime = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
};

export const formatCurrency = (amount: number): string => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
};

// Error handling utilities
export class ProfileRepositoryError extends Error {
  constructor(
    message: string,
    public code: string,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'ProfileRepositoryError';
  }
}

export const handleRepositoryError = (error: unknown): ProfileRepositoryError => {
  if (error instanceof ProfileRepositoryError) {
    return error;
  }
  
  if (error instanceof Error) {
    return new ProfileRepositoryError(
      'Failed to fetch profile data',
      'FETCH_ERROR',
      error
    );
  }
  
  return new ProfileRepositoryError(
    'Unknown error occurred',
    'UNKNOWN_ERROR'
  );
};