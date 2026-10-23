/**
 * Shared threshold definitions used across load-test scenarios.
 *
 * Acceptance criteria from issue #1624:
 *   - p95 latency < 500 ms for HTTP endpoints
 *   - p95 SSE time-to-first-byte < 1000 ms
 *   - Error rate < 1 %
 *
 * Import and spread into your scenario's `thresholds` option object:
 *
 *   import { HTTP_THRESHOLDS, SSE_THRESHOLDS } from "../lib/thresholds.js";
 *   export const options = { thresholds: { ...HTTP_THRESHOLDS } };
 */

/**
 * Standard HTTP thresholds for REST endpoints.
 *
 * http_req_duration — wall-clock time from first byte sent to last byte
 *   received (k6 built-in).
 * http_req_failed   — fraction of requests that received a non-2xx/3xx
 *   response or a network error (k6 built-in).
 */
export const HTTP_THRESHOLDS = {
  // p95 of all HTTP request durations must be below 500 ms.
  http_req_duration: ["p(95)<500"],
  // Fewer than 1 % of requests may fail (network errors + 4xx/5xx).
  http_req_failed: ["rate<0.01"],
};

/**
 * Thresholds for SSE connection scenarios.
 *
 * sse_time_to_first_event — custom Trend metric recorded inside each SSE
 *   scenario once the first data line arrives on the wire.
 * sse_connect_errors      — custom Rate metric incremented when a connection
 *   attempt is rejected (HTTP 429 / 503 / network error).
 */
export const SSE_THRESHOLDS = {
  // p95 time from TCP connect to first SSE data frame must be below 1 s.
  sse_time_to_first_event: ["p(95)<1000"],
  // Fewer than 1 % of SSE connection attempts may be refused.
  sse_connect_errors: ["rate<0.01"],
};

/**
 * Combined thresholds for scenarios that exercise both REST and SSE paths.
 */
export const ALL_THRESHOLDS = {
  ...HTTP_THRESHOLDS,
  ...SSE_THRESHOLDS,
};
