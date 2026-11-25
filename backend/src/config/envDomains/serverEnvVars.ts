import { z } from "zod";
import type { EnvVarSpec } from "../envSpec";
import { accountId, contractId, csv, decimal, flag, int, isoTimestamp, kid, rateLimit, rotation, secretSeed, text, url } from "../envSpec";

export const serverEnvVars = {
  NODE_ENV: {
    section: "Server",
    description: "Runtime mode. `test` relaxes the Stellar RPC defaults used by unit tests.",
    example: "development",
    schema: z.enum(["development", "production", "test"]),
  },
  PORT: { section: "Server", description: "HTTP port.", example: "3001", default: "3001", schema: int(1, 65_535) },
  LOG_LEVEL: {
    section: "Server",
    description: "pino log level.",
    default: "info",
    schema: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]),
  },
  ALLOWED_ORIGINS: {
    section: "Server",
    description: "Comma-separated origins allowed by CORS. Empty allows none.",
    example: "http://localhost:3000",
    schema: csv(url, "URLs"),
  },
  PUBLIC_WEB_ORIGIN: {
    section: "Server",
    description: "Public origin of the web app, used in sign-in messages.",
    default: "https://app.inversearena.com",
    schema: url,
  },
  SENTRY_DSN: {
    section: "Server",
    description: "Sentry DSN for error reporting. Leave unset to disable.",
    schema: url,
  }
} satisfies Record<string, EnvVarSpec>;
