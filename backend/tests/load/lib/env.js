/**
 * Environment helpers shared across all k6 scenarios.
 *
 * Values are sourced from k6 environment variables (__ENV) so the suite can
 * be pointed at different targets without changing script files:
 *
 *   k6 run -e BASE_URL=http://localhost:3001 -e ARENA_ID=abc123 …
 */

/** Base URL of the running backend API (no trailing slash). */
export const BASE_URL = __ENV.BASE_URL || "http://localhost:3001";

/**
 * A pre-existing arena ID that must exist in the target environment.
 * The SSE subscriber and state-read scenarios both connect to this arena.
 * Populate via k6 env: -e ARENA_ID=<uuid>
 */
export const ARENA_ID = __ENV.ARENA_ID || "test-arena-id";

/**
 * A valid JWT for authenticated routes.
 * In CI this is populated from a GitHub Actions secret or a fixture token
 * minted against the test database.
 * Set via: -e AUTH_TOKEN=<jwt>
 */
export const AUTH_TOKEN = __ENV.AUTH_TOKEN || "";

/**
 * When set to "1" the k6 scenarios will send an X-Load-Test header so that
 * the backend rate-limiter whitelist middleware can bypass counters for the
 * test VUs.  Requires the backend to be started with LOAD_TEST_KEY matching
 * LOAD_TEST_SECRET_KEY below.
 */
export const BYPASS_RATE_LIMIT = __ENV.BYPASS_RATE_LIMIT === "1";

/** Shared secret that the backend checks for the rate-limit bypass header. */
export const LOAD_TEST_SECRET_KEY =
  __ENV.LOAD_TEST_SECRET_KEY || "k6-load-test-local";

/** Convenience: build common headers for every request. */
export function commonHeaders() {
  /** @type {Record<string, string>} */
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (AUTH_TOKEN) {
    h["Authorization"] = `Bearer ${AUTH_TOKEN}`;
  }
  if (BYPASS_RATE_LIMIT) {
    h["X-Load-Test-Key"] = LOAD_TEST_SECRET_KEY;
  }
  return h;
}
