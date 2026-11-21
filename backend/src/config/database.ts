import { z } from "zod";

/**
 * Database connection configuration with role-specific pool sizing
 * 
 * Process roles:
 * - API: Short-lived request handlers (default: 10 connections)
 * - WORKER: Payment worker, outbox dispatcher (default: 5 connections)
 * - RECONCILER: Transaction reconciler (default: 3 connections)
 * - BACKFILL: Data backfill jobs (default: 2 connections)
 * - MIGRATION: Database migrations (default: 1 connection)
 */

export type ProcessRole = "API" | "WORKER" | "RECONCILER" | "BACKFILL" | "MIGRATION";

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PROCESS_ROLE: z.enum(["API", "WORKER", "RECONCILER", "BACKFILL", "MIGRATION"]).optional(),
  DB_POOL_SIZE: z
    .string()
    .optional()
    .transform((val) => (val ? Number.parseInt(val, 10) : undefined))
    .pipe(z.number().int().positive().optional()),
  DB_POOL_TIMEOUT: z
    .string()
    .optional()
    .transform((val) => (val ? Number.parseInt(val, 10) : undefined))
    .pipe(z.number().int().positive().optional()),
  DB_CONNECTION_TIMEOUT: z
    .string()
    .optional()
    .transform((val) => (val ? Number.parseInt(val, 10) : undefined))
    .pipe(z.number().int().positive().optional()),
});

// Default pool sizes per role
const ROLE_POOL_DEFAULTS: Record<ProcessRole, { connection_limit: number; pool_timeout: number }> = {
  API: {
    connection_limit: 10,
    pool_timeout: 20, // seconds
  },
  WORKER: {
    connection_limit: 5,
    pool_timeout: 30,
  },
  RECONCILER: {
    connection_limit: 3,
    pool_timeout: 30,
  },
  BACKFILL: {
    connection_limit: 2,
    pool_timeout: 60,
  },
  MIGRATION: {
    connection_limit: 1,
    pool_timeout: 300,
  },
};

export interface DatabaseConfig {
  url: string;
  connectionLimit: number;
  poolTimeout: number;
  connectionTimeout: number;
  role: ProcessRole;
}

export function getDatabaseConfig(): DatabaseConfig {
  const parsed = EnvSchema.parse({
    DATABASE_URL: process.env.DATABASE_URL,
    PROCESS_ROLE: process.env.PROCESS_ROLE,
    DB_POOL_SIZE: process.env.DB_POOL_SIZE,
    DB_POOL_TIMEOUT: process.env.DB_POOL_TIMEOUT,
    DB_CONNECTION_TIMEOUT: process.env.DB_CONNECTION_TIMEOUT,
  });

  const role: ProcessRole = parsed.PROCESS_ROLE ?? "API";
  const defaults = ROLE_POOL_DEFAULTS[role];

  return {
    url: parsed.DATABASE_URL,
    connectionLimit: parsed.DB_POOL_SIZE ?? defaults.connection_limit,
    poolTimeout: parsed.DB_POOL_TIMEOUT ?? defaults.pool_timeout,
    connectionTimeout: parsed.DB_CONNECTION_TIMEOUT ?? 10,
    role,
  };
}

/**
 * Build Prisma datasource URL with connection pool parameters
 */
export function buildDatasourceUrl(config: DatabaseConfig): string {
  const url = new URL(config.url);
  
  // Set connection pool size
  url.searchParams.set("connection_limit", config.connectionLimit.toString());
  
  // Set pool timeout (seconds to wait for available connection)
  url.searchParams.set("pool_timeout", config.poolTimeout.toString());
  
  // Set connection timeout (seconds to establish TCP connection)
  url.searchParams.set("connect_timeout", config.connectionTimeout.toString());
  
  return url.toString();
}

/**
 * Validate PgBouncer compatibility
 * - Transaction pooling mode doesn't support:
 *   - LISTEN/NOTIFY (requires session mode)
 *   - Prepared statements across transactions (unless pgbouncer_ignore in statement)
 *   - SET commands that persist beyond transaction
 */
export function validatePgBouncerMode(url: string): void {
  // Check if URL points to PgBouncer (common patterns)
  const urlObj = new URL(url);
  const isPgBouncer = 
    urlObj.hostname.includes("pgbouncer") ||
    urlObj.port === "6432" || // Common PgBouncer port
    urlObj.searchParams.has("pgbouncer");

  if (isPgBouncer) {
    console.warn("[Database] Detected PgBouncer connection:");
    console.warn("  - Transaction pooling mode is assumed");
    console.warn("  - LISTEN/NOTIFY will not work (requires session mode)");
    console.warn("  - Prepared statements are transaction-scoped");
    console.warn("  - SET commands won't persist across transactions");
  }
}
