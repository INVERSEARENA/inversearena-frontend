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

// Real API repository implementation
class ProfileApiRepository implements ProfileRepository {
  private getAuthHeaders(): HeadersInit {
    // In a browser environment, getting the token from localStorage
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('access_token');
      if (token) {
        return {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        };
      }
    }
    return { 'Content-Type': 'application/json' };
  }

  async getAgentIdentity(address?: string): Promise<AgentIdentity> {
    try {
      const response = await fetch('/api/users/me', {
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const userData = await response.json();

      // Map backend UserProfile to frontend AgentIdentity
      return {
        id: userData.id || (address ? `INV-${address.slice(-6).toUpperCase()}` : 'UNKNOWN'),
        rank: userData.currentRank || 0,
        level: Math.floor((userData.gamesPlayed || 0) / 10) + 1, // Derived level
        survivalTime: 0, // Not yet provided by backend
      };
    } catch (error) {
      console.warn('Failed to fetch real agent identity, falling back to mock or defaults', error);
      // Optional: fallback to mock logic if needed during transition, or throw the error
      return profileRepositoryMock.getAgentIdentity(address);
    }
  }

  async getProfileStats(address?: string): Promise<ProfileStats> {
    try {
      const response = await fetch('/api/users/me', {
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const userData = await response.json();

      return {
        totalStake: 0, // Pending backend support
        yieldEarned: parseFloat(userData.totalYieldEarned?.replace(/,/g, '') || '0'),
        arenasCreated: 0, // Pending backend support
        gamesPlayed: userData.gamesPlayed || 0,
        gamesWon: userData.gamesWon || 0,
        totalYieldEarned: userData.totalYieldEarned || '0.00'
      };
    } catch (error) {
      console.warn('Failed to fetch real profile stats, falling back to mock', error);
      return profileRepositoryMock.getProfileStats(address);
    }
  }

  async getMyArenas(address?: string, filter: MyArenasFilter = 'all'): Promise<MyArena[]> {
    // Placeholder: arenas endpoint doesn't exist yet, return empty or mock
    // return [];
    return profileRepositoryMock.getMyArenas(address, filter);
  }

  async getHistory(address?: string): Promise<HistoryEntry[]> {
    // Placeholder: history endpoint doesn't exist yet, return empty or mock
    // return [];
    return profileRepositoryMock.getHistory(address);
  }
}

// Instantiate both
const profileRepositoryMock = new MockProfileRepository();
const profileRepositoryApi = new ProfileApiRepository();

// Use real API repository if env var is 'false' or not set (default to real)
const useMock = process.env.NEXT_PUBLIC_USE_MOCK_PROFILE === 'true';

// Export chosen repository instance
export const profileRepository: ProfileRepository = useMock
  ? profileRepositoryMock
  : profileRepositoryApi;

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