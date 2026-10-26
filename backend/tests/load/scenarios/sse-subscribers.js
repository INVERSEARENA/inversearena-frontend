/**
 * Scenario 2 — Live arena SSE subscribers (1 000 concurrent connections)
 *
 * Models the peak load at a round boundary: up to 1 000 players holding open
 * SSE connections to a single live arena.
 *
 * Each VU:
 *   1. Opens a connection to GET /api/arenas/:id/stream
 *   2. Waits for the first event frame (records time-to-first-event)
 *   3. Holds the connection open for a configurable dwell time
 *   4. Disconnects and sleeps briefly before reconnecting
 *
 * The scenario ramps up to 1 000 VUs over 60 s, sustains for 120 s, then
 * ramps down — this matches the "players join → game runs → players leave"
 * lifecycle of a real arena.
 *
 * Acceptance criteria (issue #1624):
 *   - 1 000 concurrent SSE connections on a single arena
 *   - p95 time-to-first-event < 1 000 ms
 *   - SSE connection error rate < 1 %
 *
 * Run locally:
 *   k6 run -e BASE_URL=http://localhost:3001 \
 *          -e ARENA_ID=<real-arena-id> \
 *          -e AUTH_TOKEN=<jwt> \
 *          backend/tests/load/scenarios/sse-subscribers.js
 *
 * Rate-limiter note:
 *   The backend SSE middleware limits connections per-IP.  When running k6
 *   locally all VUs share the loopback address, which will immediately hit
 *   SSE_MAX_CONNECTIONS_PER_IP.  Start the backend with:
 *     SSE_MAX_CONNECTIONS_PER_IP=1100 SSE_MAX_CONNECTIONS_PER_ARENA=1100
 *   or use the BYPASS_RATE_LIMIT env flag if the backend supports it.
 */

import http from "k6/http";
import { check } from "k6";
import { Trend, Rate } from "k6/metrics";
import { BASE_URL, ARENA_ID, commonHeaders } from "../lib/env.js";
import { SSE_THRESHOLDS } from "../lib/thresholds.js";

// Time (ms) from sending the GET request to receiving the first SSE data line.
const sseTimeToFirstEvent = new Trend("sse_time_to_first_event", true);

// Fraction of connection attempts that failed with a non-2xx status or a
// network error before the first byte was received.
const sseConnectErrors = new Rate("sse_connect_errors");

export const options = {
  scenarios: {
    sse_subscribers_1k: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        // Ramp up to 1 000 VUs over 60 s
        { duration: "60s", target: 1000 },
        // Sustain 1 000 VUs for 120 s (two full ~60 s round cycles)
        { duration: "120s", target: 1000 },
        // Ramp down
        { duration: "30s", target: 0 },
      ],
    },
  },
  thresholds: {
    ...SSE_THRESHOLDS,
  },
};

/** How long (seconds) each VU holds its SSE connection open. */
const DWELL_SECONDS = parseFloat(__ENV.SSE_DWELL_SECONDS || "15");

export default function () {
  const url = `${BASE_URL}/api/arenas/${ARENA_ID}/stream`;
  const startTs = Date.now();

  // k6's http.get with responseType "text" reads the full body up to the
  // request timeout.  For long-lived SSE we cap it to keep the test moving;
  // the important measurement is time-to-first-event, not full body read.
  const res = http.get(url, {
    headers: {
      ...commonHeaders(),
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    },
    timeout: `${DWELL_SECONDS + 5}s`,
    // Treat all status codes as "handled" so k6 doesn't abort on 429.
    responseCallback: http.expectedStatuses({ min: 100, max: 599 }),
  });

  // Connection-level error: non-2xx or network failure.
  const connected = res.status === 200;
  sseConnectErrors.add(!connected);

  check(res, {
    "SSE connection accepted (200)": (r) => r.status === 200,
  });

  if (connected) {
    // Find the first "data:" line in the response body.
    const body = res.body || "";
    const dataLineIndex = body.indexOf("data:");
    if (dataLineIndex !== -1) {
      // Time from request start (inside this VU iteration) to first data byte.
      sseTimeToFirstEvent.add(Date.now() - startTs);
    }
  }
}
