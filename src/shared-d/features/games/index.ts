// Main hook exports
export { 
  useArenas, 
  useArenaSearch, 
  useArena,
  useFeaturedArena 
} from './hooks/useArenas';

// Type exports
export type { 
  Arena,
  ArenaStatus,
  ArenaCategory,
  ArenaFilter,
  ArenaPhase,
  ArenaSearchParams,
  UseArenasData,
  UseArenasOptions
} from './types';

// Repository exports for advanced usage
export { 
  arenasRepository,
  formatPotValue,
  formatTimeRemaining,
  getArenaStatusColor,
  getPlayerCountStatus,
  validateSearchQuery,
  normalizeSearchQuery
} from './data/arenasRepository';

// Mock data exports for testing
export { 
  mockArenas,
  featuredArena,
  getArenasByCategory,
  searchArenasByIdOrName,
  getActiveArenas,
  sortArenasByActivity
} from './data/mockArenas';