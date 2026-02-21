// Main hook exports
export { 
  useProfile, 
  useAgentIdentity, 
  useProfileStats 
} from './hooks/useProfile';

// Type exports
export type { 
  AgentIdentity, 
  ProfileStats, 
  MyArena, 
  HistoryEntry, 
  MyArenasFilter, 
  ArenaStatus, 
  HistoryAction,
  UseProfileData, 
  UseProfileOptions 
} from './types';

// Repository exports for advanced usage
export { 
  profileRepository, 
  formatSurvivalTime, 
  formatCurrency 
} from './data/profileRepository';

// Mock data exports for testing
export { 
  mockAgentIdentity, 
  mockProfileStats, 
  mockMyArenas, 
  mockHistory 
} from './data/mockProfile';