/**
 * Full suite — all three scenarios in one k6 run
 *
 * Combines the arena-list browse, SSE subscriber hold, and round-boundary
 * burst scenarios into a single execution so CI can produce one summary
 * artifact and one baseline JSON file.
 *
 * Acceptance criteria thresholds from issue #1624 are enforced here.
 *
 * Run locally (requires a running backend + a seeded arena):
 *
 *   k6 run \
 *     -e BASE_URL=http://localhost:3001 \
 *     -e ARENA_ID=<uuid> \
 *     -e AUTH_TOKEN=<jwt> \
 *     --out json=backend/tests/load/baselines/latest.json \
 *     backend/tests/load/suite.js
 *
 * Compare against a stored baseline:
 *
 *   node backend/tests/load/compare-baseline.js \
 *     backend/tests/load/baselines/baseline.json \
 *     backend/tests/load/baselines/latest.json
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";
import { BASE_URL, ARENA_ID, commonHeaders } from "./lib/env.js";
import { HTTP_THRESHOLDS, SSE_THRESHOLDS } from "./lib/thresholds.js";

// ── Custom metrics ────────────────────────────────────────────────────────────

const sseTimeToFirstEvent = new Trend("sse_time_to_first_event", true);
const sseConnectErrors = new Rate("sse_connect_errors");
const arenaStateDuration = new Trend("arena_state_duration", true);
const arenaListValidResponse = new Rate("arena_list_valid_response");
const burstReadsCompleted = new Counter("burst_reads_completed");

// ── Options ───────────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    // ── Scenario A: Arena list browse at 200 RPS ─────────────────────────────
    arena_list_browse: {
      executor: "constant-arrival-rate",
      rate: 200,
      timeUnit: "1s",
      duration: "40s",
      preAllocatedVUs: 50,
      maxVUs: 300,
      startTime: "0s",
      exec: "arenaListVU",
      tags: { scenario: "arena_list" },
    },

    // ── Scenario B: 1 000 concurrent SSE subscribers ─────────────────────────
    sse_subscribers: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "60s", target: 1000 },
        { duration: "120s", target: 1000 },
        { duration: "30s", target: 0 },
      ],
      startTime: "0s",
      exec: "sseSubscriberVU",
      tags: { scenario: "sse_subscribers" },
    },

    // ── Scenario C: Round-boundary burst (500 reads in 5 s) ──────────────────
    round_boundary_baseline: {
      executor: "constant-vus",
      vus: 10,
      duration: "5s",
      startTime: "0s",
      exec: "arenaStateVU",
      tags: { scenario: "burst", phase: "baseline" },
    },

    round_boundary_burst: {
      executor: "constant-arrival-rate",
      rate: 100,
      timeUnit: "1s",
      duration: "5s",
      preAllocatedVUs: 100,
      maxVUs: 600,
      startTime: "5s",
      exec: "arenaStateVU",
      tags: { scenario: "burst", phase: "burst" },
    },

    round_boundary_cool_down: {
      executor: "constant-vus",
      vus: 10,
      duration: "10s",
      startTime: "10s",
      exec: "arenaStateVU",
      tags: { scenario: "burst", phase: "cool_down" },
    },
  },

  thresholds: {
    ...HTTP_THRESHOLDS,
    ...SSE_THRESHOLDS,
    arena_list_valid_response: ["rate>0.95"],
    arena_state_duration: ["p(95)<500"],
    burst_reads_completed: ["count>=500"],
  },
};

// ── Scenario A: Arena list browse ─────────────────────────────────────────────

const PAGES = [
  `${BASE_URL}/api/arenas?limit=25`,
  `${BASE_URL}/api/arenas?limit=25&cursor=eyJvZmZzZXQiOjI1fQ`,
];

export function arenaListVU() {
  const url = PAGES[Math.floor(Math.random() * PAGES.length)];
  const res = http.get(url, { headers: commonHeaders() });

  const ok = check(res, {
    "arena-list 200": (r) => r.status === 200,
    "arena-list has items": (r) => {
      try {
        return Array.isArray(JSON.parse(r.body).items);
      } catch {
        return false;
      }
    },
  });
  arenaListValidResponse.add(ok);
  sleep(0.05);
}

// ── Scenario B: SSE subscribers ───────────────────────────────────────────────

const SSE_DWELL = parseFloat(__ENV.SSE_DWELL_SECONDS || "15");

export function sseSubscriberVU() {
  const url = `${BASE_URL}/api/arenas/${ARENA_ID}/stream`;
  const startTs = Date.now();

  const res = http.get(url, {
    headers: {
      ...commonHeaders(),
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    },
    timeout: `${SSE_DWELL + 5}s`,
    responseCallback: http.expectedStatuses({ min: 100, max: 599 }),
  });

  const connected = res.status === 200;
  sseConnectErrors.add(!connected);

  check(res, {
    "sse connection accepted": (r) => r.status === 200,
  });

  if (connected) {
    const body = res.body || "";
    if (body.indexOf("data:") !== -1) {
      sseTimeToFirstEvent.add(Date.now() - startTs);
    }
  }
}

// ── Scenario C: Arena state reads ────────────────────────────────────────────

export function arenaStateVU() {
  const url = `${BASE_URL}/api/arenas/${ARENA_ID}`;
  const start = Date.now();

  const res = http.get(url, {
    headers: commonHeaders(),
    tags: { name: "arena_state_read" },
  });

  arenaStateDuration.add(Date.now() - start);

  const ok = check(res, {
    "arena-state 200": (r) => r.status === 200,
  });

  if (ok) {
    burstReadsCompleted.add(1);
  }
}
