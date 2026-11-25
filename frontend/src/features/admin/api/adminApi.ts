// Admin API functions

import type {
  AdminMetrics,
  ArenaConfig,
  UserManagement,
  SystemHealth,
  Transaction,
  GovernanceProposal,
  ModerationAction,
} from "../types";

/**
 * Fetch admin metrics overview
 */
export async function fetchAdminMetrics(): Promise<AdminMetrics> {
  const response = await fetch("/api/admin/metrics");
  if (!response.ok) {
    throw new Error("Failed to fetch admin metrics");
  }
  return response.json();
}

/**
 * Fetch all arenas for admin management
 */
export async function fetchArenas(): Promise<ArenaConfig[]> {
  const response = await fetch("/api/admin/arenas");
  if (!response.ok) {
    throw new Error("Failed to fetch arenas");
  }
  return response.json();
}

/**
 * Update arena configuration
 */
export async function updateArenaConfig(
  arenaId: string,
  config: Partial<ArenaConfig>
): Promise<ArenaConfig> {
  const response = await fetch(`/api/admin/arenas/${arenaId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw new Error("Failed to update arena configuration");
  }
  return response.json();
}

/**
 * Fetch users for admin management
 */
export async function fetchUsers(): Promise<UserManagement[]> {
  const response = await fetch("/api/admin/users");
  if (!response.ok) {
    throw new Error("Failed to fetch users");
  }
  return response.json();
}

/**
 * Update user status
 */
export async function updateUserStatus(
  userId: string,
  status: "active" | "suspended" | "banned"
): Promise<UserManagement> {
  const response = await fetch(`/api/admin/users/${userId}/status`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status }),
  });
  if (!response.ok) {
    throw new Error("Failed to update user status");
  }
  return response.json();
}

/**
 * Fetch system health status
 */
export async function fetchSystemHealth(): Promise<SystemHealth> {
  const response = await fetch("/api/admin/system/health");
  if (!response.ok) {
    throw new Error("Failed to fetch system health");
  }
  return response.json();
}

/**
 * Fetch recent transactions
 */
export async function fetchTransactions(limit = 100): Promise<Transaction[]> {
  const response = await fetch(`/api/admin/transactions?limit=${limit}`);
  if (!response.ok) {
    throw new Error("Failed to fetch transactions");
  }
  return response.json();
}

/**
 * Fetch governance proposals
 */
export async function fetchGovernanceProposals(): Promise<GovernanceProposal[]> {
  const response = await fetch("/api/admin/governance/proposals");
  if (!response.ok) {
    throw new Error("Failed to fetch governance proposals");
  }
  return response.json();
}

/**
 * Create moderation action
 */
export async function createModerationAction(
  action: Omit<ModerationAction, "id" | "timestamp">
): Promise<ModerationAction> {
  const response = await fetch("/api/admin/moderation/actions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(action),
  });
  if (!response.ok) {
    throw new Error("Failed to create moderation action");
  }
  return response.json();
}
