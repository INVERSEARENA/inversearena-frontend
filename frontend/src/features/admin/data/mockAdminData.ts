// Mock data for admin feature development

import type {
  AdminMetrics,
  ArenaConfig,
  UserManagement,
  SystemHealth,
  Transaction,
  GovernanceProposal,
  ModerationAction,
} from "../types";

export const mockAdminMetrics: AdminMetrics = {
  totalArenas: 145,
  activeArenas: 98,
  totalPlayers: 12_543,
  activePlayers: 8_234,
  totalVolume: 45_680_000,
  platformFees: 456_800,
};

export const mockArenas: ArenaConfig[] = [
  {
    id: "arena-001",
    name: "Whale Wars Championship",
    status: "active",
    entryFee: 1000,
    maxPlayers: 100,
    currentPlayers: 78,
    joinDeadline: new Date("2026-12-31T23:59:59Z"),
    createdAt: new Date("2026-11-01T00:00:00Z"),
  },
  {
    id: "arena-002",
    name: "Stable Yield Arena",
    status: "active",
    entryFee: 100,
    maxPlayers: 500,
    currentPlayers: 423,
    joinDeadline: new Date("2026-12-25T23:59:59Z"),
    createdAt: new Date("2026-11-05T00:00:00Z"),
  },
  {
    id: "arena-003",
    name: "Quick Blitz Round",
    status: "paused",
    entryFee: 50,
    maxPlayers: 200,
    currentPlayers: 156,
    joinDeadline: new Date("2026-12-20T23:59:59Z"),
    createdAt: new Date("2026-11-10T00:00:00Z"),
  },
  {
    id: "arena-004",
    name: "Elite Tournament",
    status: "closed",
    entryFee: 5000,
    maxPlayers: 50,
    currentPlayers: 50,
    joinDeadline: new Date("2026-11-15T23:59:59Z"),
    createdAt: new Date("2026-10-01T00:00:00Z"),
  },
];

export const mockSystemHealth: SystemHealth = {
  status: "healthy",
  cpu: 45,
  memory: 62,
  network: "stable",
  lastChecked: new Date(),
};

export const mockUsers: UserManagement[] = [
  {
    id: "user-001",
    walletAddress: "GABC...XYZ1",
    status: "active",
    joinedAt: new Date("2026-01-15T00:00:00Z"),
    totalGames: 145,
    totalWinnings: 45_000,
  },
  {
    id: "user-002",
    walletAddress: "GDEF...XYZ2",
    status: "active",
    joinedAt: new Date("2026-02-20T00:00:00Z"),
    totalGames: 89,
    totalWinnings: 23_500,
  },
  {
    id: "user-003",
    walletAddress: "GHIJ...XYZ3",
    status: "suspended",
    joinedAt: new Date("2026-03-10T00:00:00Z"),
    totalGames: 34,
    totalWinnings: 8_900,
  },
];

export const mockTransactions: Transaction[] = [
  {
    id: "tx-001",
    type: "entry_fee",
    amount: 1000,
    currency: "XLM",
    status: "completed",
    userId: "user-001",
    timestamp: new Date("2026-11-21T10:30:00Z"),
  },
  {
    id: "tx-002",
    type: "payout",
    amount: 5000,
    currency: "XLM",
    status: "completed",
    userId: "user-002",
    timestamp: new Date("2026-11-21T09:15:00Z"),
  },
  {
    id: "tx-003",
    type: "deposit",
    amount: 10000,
    currency: "XLM",
    status: "pending",
    userId: "user-003",
    timestamp: new Date("2026-11-21T11:00:00Z"),
  },
];

export const mockGovernanceProposals: GovernanceProposal[] = [
  {
    id: "prop-001",
    title: "Increase Platform Fee to 3%",
    description: "Proposal to increase the platform fee from 2% to 3% to fund development",
    status: "active",
    votesFor: 1234,
    votesAgainst: 567,
    createdAt: new Date("2026-11-15T00:00:00Z"),
    endsAt: new Date("2026-11-30T23:59:59Z"),
  },
  {
    id: "prop-002",
    title: "Add New Game Mode: Team Arena",
    description: "Introduce a team-based arena mode with 5v5 competition",
    status: "passed",
    votesFor: 3456,
    votesAgainst: 234,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    endsAt: new Date("2026-10-15T23:59:59Z"),
  },
];

export const mockModerationActions: ModerationAction[] = [
  {
    id: "mod-001",
    type: "suspend",
    targetUserId: "user-003",
    reason: "Suspected bot activity",
    adminId: "admin-001",
    timestamp: new Date("2026-11-20T14:30:00Z"),
  },
  {
    id: "mod-002",
    type: "warn",
    targetUserId: "user-004",
    reason: "Inappropriate username",
    adminId: "admin-001",
    timestamp: new Date("2026-11-19T10:15:00Z"),
  },
];
