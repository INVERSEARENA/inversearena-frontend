// Types for dashboard home page components

export interface ArenaCard {
  id: string;
  name: string;
  currentPot: number;
  currency: string;
  maxPlayers: number;
  currentPlayers: number;
  description: string;
  status: "live" | "upcoming" | "ended";
}

export interface YieldData {
  globalYield: number;
  apy: number;
  sinceLastEpoch: string;
  rwaAllocation: number; // percentage 0-100
}

export interface IntelItem {
  id: string;
  type: "won" | "eliminated" | "joined";
  message: string;
  address: string;
  arenaRef: string;
  round?: number;
}

export interface GameResult {
  id: string;
  arenaId: string;
  arenaName: string;
  result: "won" | "eliminated";
  prize?: number;
  currency?: string;
  round?: number;
}

export interface Announcement {
  id: string;
  title: string;
  content: string;
  link?: string;
}

export interface NetworkMetrics {
  load: "low" | "medium" | "high";
  gasPrice: number;
  gasCurrency: string;
}
