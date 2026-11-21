// Admin feature types

export interface AdminMetrics {
  totalArenas: number;
  activeArenas: number;
  totalPlayers: number;
  activePlayers: number;
  totalVolume: number;
  platformFees: number;
}

export interface ArenaConfig {
  id: string;
  name: string;
  status: "active" | "paused" | "closed";
  entryFee: number;
  maxPlayers: number;
  currentPlayers: number;
  joinDeadline: Date;
  createdAt: Date;
}

export interface UserManagement {
  id: string;
  walletAddress: string;
  status: "active" | "suspended" | "banned";
  joinedAt: Date;
  totalGames: number;
  totalWinnings: number;
}

export interface SystemHealth {
  status: "healthy" | "degraded" | "down";
  cpu: number;
  memory: number;
  network: "stable" | "unstable";
  lastChecked: Date;
}

export interface Transaction {
  id: string;
  type: "deposit" | "withdrawal" | "entry_fee" | "payout";
  amount: number;
  currency: string;
  status: "pending" | "completed" | "failed";
  userId: string;
  timestamp: Date;
}

export interface GovernanceProposal {
  id: string;
  title: string;
  description: string;
  status: "active" | "passed" | "rejected" | "pending";
  votesFor: number;
  votesAgainst: number;
  createdAt: Date;
  endsAt: Date;
}

export interface ModerationAction {
  id: string;
  type: "warn" | "suspend" | "ban" | "unban";
  targetUserId: string;
  reason: string;
  adminId: string;
  timestamp: Date;
}

export type AdminTab = 
  | "overview" 
  | "arenas" 
  | "users" 
  | "transactions" 
  | "governance" 
  | "moderation" 
  | "system";

export interface AdminState {
  activeTab: AdminTab;
  metrics?: AdminMetrics;
  systemHealth?: SystemHealth;
}
