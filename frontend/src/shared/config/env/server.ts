/**
 * Server-only environment values (#1650).
 *
 * Reads through to `process.env` on every access, so tests that set a
 * variable before exercising code see it, and the Edge runtime (src/proxy.ts)
 * reads the values injected at deploy. Reading one in the browser throws: it
 * would be `undefined` there and hide a server-only dependency in client code.
 */
import { SERVER_ENV_VARS, type ServerEnvKey } from "./spec";

export const serverEnv: Readonly<Record<ServerEnvKey, string | undefined>> = new Proxy(
  {} as Record<ServerEnvKey, string | undefined>,
  {
    get(_target, name) {
      if (typeof name !== "string" || !(name in SERVER_ENV_VARS)) {
        throw new Error(`Undeclared server environment variable ${String(name)}: add it to shared/config/env/spec.ts`);
      }
      if (typeof window !== "undefined") {
        throw new Error(`${name} is server-only and cannot be read in the browser`);
      }
      return process.env[name];
    },
  },
);
