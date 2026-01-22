import { useState, useEffect, useCallback } from 'react';
import { 
  UseArenasData, 
  UseArenasOptions, 
  ArenaFilter,
  Arena
} from '../types';
import { 
  arenasRepository, 
  handleRepositoryError,
  validateSearchQuery,
  normalizeSearchQuery
} from '../data/arenasRepository';

// Hook implementation
export function useArenas(options: UseArenasOptions = {}): UseArenasData & {
  setFilter: (filter: ArenaFilter) => void;
  setSearch: (search: string) => void;
  refetch: () => Promise<void>;
} {
  const { 
    filter = 'all', 
    search = '', 
    includeCompleted = false,
    limit 
  } = options;
  
  // State management
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [error, setError] = useState<string | undefined>();
  const [currentFilter, setCurrentFilter] = useState<ArenaFilter>(filter);
  const [currentSearch, setCurrentSearch] = useState<string>(search);
  
  // Data states
  const [arenas, setArenas] = useState<Arena[]>([]);
  const [featuredArena, setFeaturedArena] = useState<Arena | undefined>();
  const [totalCount, setTotalCount] = useState(0);

  // Fetch arenas data
  const fetchArenas = useCallback(async () => {
    try {
      setStatus('loading');
      setError(undefined);

      // Validate search query
      if (currentSearch && !validateSearchQuery(currentSearch)) {
        throw new Error('Invalid search query. Use only letters, numbers, spaces, and # symbol.');
      }

      // Fetch arenas and featured arena in parallel
      const [arenasData, featuredData] = await Promise.all([
        arenasRepository.getArenas({
          filter: currentFilter,
          search: normalizeSearchQuery(currentSearch)
        }),
        arenasRepository.getFeaturedArena()
      ]);

      let processedArenas = arenasData;

      // Apply limit if specified
      if (limit && limit > 0) {
        processedArenas = arenasData.slice(0, limit);
      }

      setArenas(processedArenas);
      setFeaturedArena(featuredData);
      setTotalCount(arenasData.length);
      setStatus('success');

    } catch (err) {
      const repositoryError = handleRepositoryError(err);
      setError(repositoryError.message);
      setStatus('error');
    }
  }, [currentFilter, currentSearch, includeCompleted, limit]);

  // Filter change handler
  const setFilter = useCallback((newFilter: ArenaFilter) => {
    setCurrentFilter(newFilter);
  }, []);

  // Search change handler
  const setSearch = useCallback((newSearch: string) => {
    setCurrentSearch(newSearch);
  }, []);

  // Refetch function for manual refresh
  const refetch = useCallback(async () => {
    await fetchArenas();
  }, [fetchArenas]);

  // Initial data fetch and refetch on dependencies change
  useEffect(() => {
    fetchArenas();
  }, [fetchArenas]);

  return {
    arenas,
    featuredArena,
    status,
    error,
    totalCount,
    filteredCount: arenas.length,
    setFilter,
    setSearch,
    refetch
  };
}

// Convenience hook for just searching arenas by ID
export function useArenaSearch(searchTerm: string) {
  const [arena, setArena] = useState<Arena | undefined>();
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const searchArena = async () => {
      if (!searchTerm.trim()) {
        setArena(undefined);
        setStatus('idle');
        return;
      }

      try {
        setStatus('loading');
        setError(undefined);

        // Check if search is numeric (for ID search)
        const numericSearch = parseInt(searchTerm.replace('#', ''));
        if (!isNaN(numericSearch)) {
          const foundArena = await arenasRepository.getArenaByDisplayId(numericSearch);
          setArena(foundArena);
        } else {
          // Text search - get all arenas and filter
          const arenas = await arenasRepository.getArenas({
            filter: 'all',
            search: searchTerm
          });
          setArena(arenas[0]); // Return first match
        }

        setStatus('success');
      } catch (err) {
        const repositoryError = handleRepositoryError(err);
        setError(repositoryError.message);
        setStatus('error');
      }
    };

    searchArena();
  }, [searchTerm]);

  return { arena, status, error };
}

// Hook for getting a single arena by ID
export function useArena(arenaId: string | number) {
  const [arena, setArena] = useState<Arena | undefined>();
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const fetchArena = async () => {
      try {
        setStatus('loading');
        setError(undefined);

        let foundArena: Arena | undefined;
        
        if (typeof arenaId === 'number') {
          foundArena = await arenasRepository.getArenaByDisplayId(arenaId);
        } else {
          foundArena = await arenasRepository.getArenaById(arenaId);
        }

        setArena(foundArena);
        setStatus('success');
      } catch (err) {
        const repositoryError = handleRepositoryError(err);
        setError(repositoryError.message);
        setStatus('error');
      }
    };

    if (arenaId) {
      fetchArena();
    } else {
      setArena(undefined);
      setStatus('idle');
    }
  }, [arenaId]);

  return { arena, status, error };
}

// Hook for featured arena only
export function useFeaturedArena() {
  const [featuredArena, setFeaturedArena] = useState<Arena | undefined>();
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const fetchFeatured = async () => {
      try {
        setStatus('loading');
        const featured = await arenasRepository.getFeaturedArena();
        setFeaturedArena(featured);
        setStatus('success');
      } catch (err) {
        const repositoryError = handleRepositoryError(err);
        setError(repositoryError.message);
        setStatus('error');
      }
    };

    fetchFeatured();
  }, []);

  return { featuredArena, status, error };
}

// Export types for external use
export type { UseArenasData, UseArenasOptions, ArenaFilter };