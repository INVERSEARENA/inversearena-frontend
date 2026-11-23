/**
 * Scenario 3 — Round-boundary burst (500 arena state reads in 5 s)
 *
 * Models the spike that occurs the moment a round resolves: every connected
 * client immediately polls GET /api/arenas/:id to refresh the UI with the
 * new round state.
 *
 * Shape:
 *   - Warm up with 10 VUs for 5 s (establishes baseline latency)
 *   - Inject a sharp spike of 500 arrivals in 5 s (the "round boundary")
 *   - Cool down for 10 s
 *
 * Acceptance criteria (issue #1624):
 *   - 500 state reads completed in ≤ 5 s
 *   - p95 latency < 500 ms
 *   - Error rate < 1 %
 *
 * Run locally:
 *   k6 run -e BASE_URL=http://localhost:3001 \
 *          -e ARENA_ID=<real-arena-id> \
 *          backend/tests/load/scenarios/round-boundary-burst.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";
import { BASE_URL, ARENA_ID, commonHeaders } from "../lib/env.js";
import { HTTP_THRESHOLDS } from "../lib/thresholds.js";

// Total number of successful state reads during the burst window.
const burstReadsCompleted = new Counter("burst_reads_completed");

// Latency of GET /api/arenas/:id specifically (isolated from other requests).
const arenaStateDuration = new Trend("arena_state_duration", true);

export const options = {
  scenarios: {
    // Baseline: steady low traffic before the burst.
    baseline: {
      executor: "constant-vus",
      vus: 10,
      duration: "5s",
      // Run before the burst.
      startTime: "0s",
      tags: { phase: "baseline" },
    },

    // Burst: inject 500 arrivals within 5 s.
    round_boundary_burst: {
      executor: "constant-arrival-rate",
      rate: 100,      // 100 arrivals/s × 5 s = 500 total
      timeUnit: "1s",
      duration: "5s",
      preAllocatedVUs: 100,
      maxVUs: 600,
      // Offset so the burst starts after the baseline warms up.
      startTime: "5s",
      tags: { phase: "burst" },
    },

    // Cool-down: verify latency returns to baseline after the burst.
    cool_down: {
      executor: "constant-vus",
      vus: 10,
      duration: "10s",
      startTime: "10s",
      tags: { phase: "cool_down" },
    },
  },
  thresholds: {
    ...HTTP_THRESHOLDS,
    // All 500 burst reads must complete.
    burst_reads_completed: ["count>=500"],
    // p95 for the isolated arena-state metric must also be within budget.
    arena_state_duration: ["p(95)<500"],
  },
};

export default function () {
  const url = `${BASE_URL}/api/arenas/${ARENA_ID}`;
  const start = Date.now();

  const res = http.get(url, {
    headers: commonHeaders(),
    tags: { name: "arena_state_read" },
  });

  arenaStateDuration.add(Date.now() - start);

  const ok = check(res, {
    "status 200": (r) => r.status === 200,
    "response has arena id": (r) => {
      try {
        const body = JSON.parse(r.body);
        return typeof body.id === "string" || typeof body.arena?.id === "string";
      } catch {
        return false;
      }
    },
  });

  if (ok) {
    burstReadsCompleted.add(1);
  }

  // No sleep in burst scenario — we want maximum throughput.
  if (__ENV.K6_SCENARIO === "baseline" || __ENV.K6_SCENARIO === "cool_down") {
    sleep(0.1);
  }
}
