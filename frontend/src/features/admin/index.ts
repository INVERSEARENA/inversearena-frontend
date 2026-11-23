// Admin feature exports

// Components
export {
  MetricsOverview,
  ArenaManagementPanel,
  SystemHealthPanel,
  AdminTabs,
} from "./components";

// Hooks
export {
  useAdminMetrics,
  useArenaManagement,
  useSystemHealth,
} from "./hooks";

// Types
export type {
  AdminMetrics,
  ArenaConfig,
  UserManagement,
  SystemHealth,
  Transaction,
  GovernanceProposal,
  ModerationAction,
  AdminTab,
  AdminState,
} from "./types";

// API
export {
  fetchAdminMetrics,
  fetchArenas,
  updateArenaConfig,
  fetchUsers,
  updateUserStatus,
  fetchSystemHealth,
  fetchTransactions,
  fetchGovernanceProposals,
  createModerationAction,
} from "./api/adminApi";
