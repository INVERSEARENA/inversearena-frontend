import { useState, useEffect, useCallback } from 'react';
import { 
  UseProfileData, 
  UseProfileOptions, 
  MyArenasFilter,
  AgentIdentity,
  ProfileStats,
  MyArena,
  HistoryEntry
} from '../types';
import { 
  profileRepository, 
  handleRepositoryError 
} from '../data/profileRepository';

// Hook implementation
export function useProfile(options: UseProfileOptions = {}): UseProfileData & {
  setMyArenasFilter: (filter: MyArenasFilter) => void;
  refetch: () => Promise<void>;
} {
  const { address, myArenasFilter = 'all' } = options;
  
  // State management
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [error, setError] = useState<string | undefined>();
  const [currentFilter, setCurrentFilter] = useState<MyArenasFilter>(myArenasFilter);
  
  // Data states
  const [identity, setIdentity] = useState<AgentIdentity | null>(null);
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [myArenas, setMyArenas] = useState<MyArena[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  // Fetch all profile data
  const fetchProfileData = useCallback(async () => {
    try {
      setStatus('loading');
      setError(undefined);

      // Fetch all data in parallel for better performance
      const [
        identityData,
        statsData,
        arenasData,
        historyData
      ] = await Promise.all([
        profileRepository.getAgentIdentity(address),
        profileRepository.getProfileStats(address),
        profileRepository.getMyArenas(address, currentFilter),
        profileRepository.getHistory(address)
      ]);

      setIdentity(identityData);
      setStats(statsData);
      setMyArenas(arenasData);
      setHistory(historyData);
      setStatus('success');

    } catch (err) {
      const repositoryError = handleRepositoryError(err);
      setError(repositoryError.message);
      setStatus('error');
    }
  }, [address, currentFilter]);

  // Filter change handler
  const setMyArenasFilter = useCallback(async (filter: MyArenasFilter) => {
    setCurrentFilter(filter);
    
    try {
      // Only refetch arenas when filter changes
      const arenasData = await profileRepository.getMyArenas(address, filter);
      setMyArenas(arenasData);
    } catch (err) {
      const repositoryError = handleRepositoryError(err);
      setError(repositoryError.message);
    }
  }, [address]);

  // Refetch function for manual refresh
  const refetch = useCallback(async () => {
    await fetchProfileData();
  }, [fetchProfileData]);

  // Initial data fetch
  useEffect(() => {
    fetchProfileData();
  }, [fetchProfileData]);

  // Provide stable default objects during loading
  const defaultIdentity: AgentIdentity = {
    id: '...',
    rank: 0,
    level: 0,
    survivalTime: 0
  };

  const defaultStats: ProfileStats = {
    totalStake: 0,
    yieldEarned: 0,
    arenasCreated: 0
  };

  return {
    profile: {
      identity: identity || defaultIdentity,
      stats: stats || defaultStats
    },
    myArenas,
    history,
    status,
    error,
    setMyArenasFilter,
    refetch
  };
}

// Convenience hook for just identity data
export function useAgentIdentity(address?: string) {
  const [identity, setIdentity] = useState<AgentIdentity | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const fetchIdentity = async () => {
      try {
        setStatus('loading');
        const data = await profileRepository.getAgentIdentity(address);
        setIdentity(data);
        setStatus('success');
      } catch (err) {
        const repositoryError = handleRepositoryError(err);
        setError(repositoryError.message);
        setStatus('error');
      }
    };

    fetchIdentity();
  }, [address]);

  return { identity, status, error };
}

// Convenience hook for just stats data
export function useProfileStats(address?: string) {
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const fetchStats = async () => {
      try {
        setStatus('loading');
        const data = await profileRepository.getProfileStats(address);
        setStats(data);
        setStatus('success');
      } catch (err) {
        const repositoryError = handleRepositoryError(err);
        setError(repositoryError.message);
        setStatus('error');
      }
    };

    fetchStats();
  }, [address]);

  return { stats, status, error };
}

// Export types for external use
export type { UseProfileData, UseProfileOptions, MyArenasFilter };