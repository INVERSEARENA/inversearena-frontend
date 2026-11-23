export type RouteClass =
  | "AUTH_NONCE"
  | "AUTH_VERIFY"
  | "AUTH_REFRESH"
  | "POOLS_CREATE"
  | "ARENAS_SYNC_PLAYERS"
  | "ARENAS_RESERVATION"
  | "SIMULATIONS"
  | "ADMIN_WALLET_ROLE";

export interface RateLimitPolicyConfig {
  keyPrefix: string;
  points: number;
  durationSeconds: number;
  dualScope?: boolean;
}

export type HeaderGetter =
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>;

export interface RateLimitConsumeResult {
  allowed: boolean;
  retryAfterSeconds: number;
}
