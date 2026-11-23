import { z } from "zod";
import type { EnvVarSpec } from "../envSpec";
import { accountId, contractId, csv, decimal, flag, int, isoTimestamp, kid, rateLimit, rotation, secretSeed, text, url } from "../envSpec";

export const dataStoreEnvVars = {
  DATABASE_URL: {
    section: "Data stores",
    description: "PostgreSQL connection string (Prisma).",
    example: "postgresql://postgres:postgres@localhost:5432/inversearena?schema=public",
    required: true,
    secret: true,
    schema: url,
  },
  MONGODB_URI: {
    section: "Data stores",
    description: "MongoDB connection string for transactions and intents.",
    example: "mongodb://localhost:27017/inversearena",
    required: true,
    secret: true,
    schema: url,
  },
  REDIS_URL: {
    section: "Data stores",
    description: "Redis for caching, queues and the shared rate limit.",
    example: "redis://localhost:6379",
    default: "redis://localhost:6379",
    secret: true,
    schema: url,
  }
} satisfies Record<string, EnvVarSpec>;
