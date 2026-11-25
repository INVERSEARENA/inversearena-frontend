/**
 * Boot-time environment check (#1650).
 *
 * server.ts imports this immediately after `dotenv/config`. Imports run in
 * order, so a missing or malformed variable stops the process here, with every
 * problem listed at once, before any later module opens a connection or reads
 * config deep in a request path.
 */
import { EnvValidationError, validateEnv } from "./env";

try {
  validateEnv();
} catch (error) {
  if (!(error instanceof EnvValidationError)) throw error;
  // console, not the logger: the logger itself is configured from env.
  console.error(error.message);
  process.exit(1);
}
