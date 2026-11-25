import { z } from "zod";
import type { EnvVarSpec } from "../envSpec";
import { accountId, contractId, csv, decimal, flag, int, isoTimestamp, kid, rateLimit, rotation, secretSeed, text, url } from "../envSpec";

export const rateLimitEnvVars = {
  RATE_LIMIT_APP_NAMESPACE: {
    section: "Rate limiting",
    description: "Prefix that separates this app's rate-limit keys in a shared Redis.",
    schema: text,
  },
  TRUSTED_PROXY_COUNT: {
    section: "Rate limiting",
    description:
      "Reverse proxies in front of the app. Controls how X-Forwarded-For is read for rate-limit buckets; 0 ignores the header.",
    default: "0",
    schema: int(0),
  },
  ...rateLimit("auth nonce requests", "NONCE", 5, 60),
  ...rateLimit("auth verify requests", "VERIFY", 10, 60),
  ...rateLimit("token refreshes", "REFRESH", 20, 60),
  ...rateLimit("pool creation", "POOLS", 3, 60),
  ...rateLimit("arena player syncs", "SYNC_PLAYERS", 3, 60),
  ...rateLimit("lobby reservations", "RESERVATION", 10, 60),
  ...rateLimit("admin wallet-role checks", "WALLET_ROLE", 20, 60),
  ...rateLimit("transaction simulations", "SIMULATION", 5, 60),
  SSE_MAX_CONNECTIONS_PER_IP: {
    section: "Rate limiting",
    description: "Active SSE streams accepted per client IP.",
    default: "5",
    schema: int(1),
  },
  SSE_MAX_CONNECTIONS_PER_ARENA: {
    section: "Rate limiting",
    description: "Active SSE streams accepted per arena.",
    default: "100",
    schema: int(1),
  }
} satisfies Record<string, EnvVarSpec>;
