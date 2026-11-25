import type { RateLimitPolicyConfig, RouteClass } from "./types";

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

/**
 * Default policy table shared across frontend and backend runtimes.
 * Route class → points/duration/dualScope.
 */
export const DEFAULT_POLICY_TABLE: Record<RouteClass, RateLimitPolicyConfig> = {
  AUTH_NONCE: {
    keyPrefix: "rl:auth:nonce",
    points: 5,
    durationSeconds: 60,
  },
  AUTH_VERIFY: {
    keyPrefix: "rl:auth:verify",
    points: 10,
    durationSeconds: 60,
    dualScope: true,
  },
  AUTH_REFRESH: {
    keyPrefix: "rl:auth:refresh",
    points: 20,
    durationSeconds: 60,
  },
  POOLS_CREATE: {
    keyPrefix: "rl:pools:create",
    points: 3,
    durationSeconds: 60,
  },
  ARENAS_SYNC_PLAYERS: {
    keyPrefix: "rl:arenas:sync-players",
    points: 3,
    durationSeconds: 60,
  },
  ARENAS_RESERVATION: {
    keyPrefix: "rl:arenas:reservation",
    points: 10,
    durationSeconds: 60,
  },
  SIMULATIONS: {
    keyPrefix: "rl:simulations",
    points: 5,
    durationSeconds: 60,
    dualScope: true,
  },
  ADMIN_WALLET_ROLE: {
    keyPrefix: "rl:admin:wallet-role",
    points: 20,
    durationSeconds: 60,
  },
};

/**
 * Resolve runtime configuration for a route class, applying environment variable overrides.
 */
export function getRoutePolicy(routeClass: RouteClass): RateLimitPolicyConfig {
  const base = DEFAULT_POLICY_TABLE[routeClass];
  switch (routeClass) {
    case "AUTH_NONCE":
      return {
        keyPrefix: process.env.RATE_LIMIT_NONCE_PREFIX ?? base.keyPrefix,
        points: readPositiveInt("RATE_LIMIT_NONCE_POINTS", base.points),
        durationSeconds: readPositiveInt("RATE_LIMIT_NONCE_WINDOW_SECONDS", base.durationSeconds),
      };
    case "AUTH_VERIFY":
      return {
        keyPrefix: process.env.RATE_LIMIT_VERIFY_PREFIX ?? base.keyPrefix,
        points: readPositiveInt("RATE_LIMIT_VERIFY_POINTS", base.points),
        durationSeconds: readPositiveInt("RATE_LIMIT_VERIFY_WINDOW_SECONDS", base.durationSeconds),
        dualScope: true,
      };
    case "AUTH_REFRESH":
      return {
        keyPrefix: process.env.RATE_LIMIT_REFRESH_PREFIX ?? base.keyPrefix,
        points: readPositiveInt("RATE_LIMIT_REFRESH_POINTS", base.points),
        durationSeconds: readPositiveInt("RATE_LIMIT_REFRESH_WINDOW_SECONDS", base.durationSeconds),
      };
    case "POOLS_CREATE":
      return {
        keyPrefix: process.env.RATE_LIMIT_POOLS_PREFIX ?? base.keyPrefix,
        points: readPositiveInt("RATE_LIMIT_POOLS_POINTS", base.points),
        durationSeconds: readPositiveInt("RATE_LIMIT_POOLS_WINDOW_SECONDS", base.durationSeconds),
      };
    case "ARENAS_SYNC_PLAYERS":
      return {
        keyPrefix: process.env.RATE_LIMIT_SYNC_PLAYERS_PREFIX ?? base.keyPrefix,
        points: readPositiveInt("RATE_LIMIT_SYNC_PLAYERS_POINTS", base.points),
        durationSeconds: readPositiveInt("RATE_LIMIT_SYNC_PLAYERS_WINDOW_SECONDS", base.durationSeconds),
      };
    case "ARENAS_RESERVATION":
      return {
        keyPrefix: process.env.RATE_LIMIT_RESERVATION_PREFIX ?? base.keyPrefix,
        points: readPositiveInt("RATE_LIMIT_RESERVATION_POINTS", base.points),
        durationSeconds: readPositiveInt("RATE_LIMIT_RESERVATION_WINDOW_SECONDS", base.durationSeconds),
      };
    case "SIMULATIONS":
      return {
        keyPrefix: process.env.RATE_LIMIT_SIMULATION_PREFIX ?? base.keyPrefix,
        points: readPositiveInt("RATE_LIMIT_SIMULATION_POINTS", base.points),
        durationSeconds: readPositiveInt("RATE_LIMIT_SIMULATION_WINDOW_SECONDS", base.durationSeconds),
        dualScope: true,
      };
    case "ADMIN_WALLET_ROLE":
      return {
        keyPrefix: process.env.RATE_LIMIT_WALLET_ROLE_PREFIX ?? base.keyPrefix,
        points: readPositiveInt("RATE_LIMIT_WALLET_ROLE_POINTS", base.points),
        durationSeconds: readPositiveInt("RATE_LIMIT_WALLET_ROLE_WINDOW_SECONDS", base.durationSeconds),
      };
  }
}
