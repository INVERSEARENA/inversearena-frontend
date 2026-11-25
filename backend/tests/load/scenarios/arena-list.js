/**
 * Scenario 1 — Arena list browse (200 RPS steady state)
 *
 * Models the "lobby browse" traffic pattern: many players open the arena
 * listing page and paginate through available arenas before joining one.
 *
 * Acceptance criteria (issue #1624):
 *   - Sustain 200 RPS against GET /api/arenas
 *   - p95 latency < 500 ms
 *   - Error rate < 1 %
 *
 * Run locally:
 *   k6 run -e BASE_URL=http://localhost:3001 \
 *          backend/tests/load/scenarios/arena-list.js
 *
 * Rate-limiter bypass (optional):
 *   k6 run -e BYPASS_RATE_LIMIT=1 \
 *          -e LOAD_TEST_SECRET_KEY=<secret> \
 *          -e BASE_URL=http://localhost:3001 \
 *          backend/tests/load/scenarios/arena-list.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";
import { BASE_URL, commonHeaders } from "../lib/env.js";
import { HTTP_THRESHOLDS } from "../lib/thresholds.js";

// Custom metric: tracks the fraction of responses that carried a valid JSON
// body with an "items" array (a proxy for correct API contract adherence).
const validResponseRate = new Rate("arena_list_valid_response");

export const options = {
  scenarios: {
    arena_list_200rps: {
      executor: "constant-arrival-rate",
      // Target: 200 requests per second
      rate: 200,
      timeUnit: "1s",
      // Pre-allocate enough VUs.  k6 will add more up to maxVUs if needed.
      preAllocatedVUs: 50,
      maxVUs: 300,
      // Duration: 30 s of steady load + 10 s warm-up
      duration: "40s",
    },
  },
  thresholds: {
    ...HTTP_THRESHOLDS,
    // At least 95 % of responses must include a valid items array.
    arena_list_valid_response: ["rate>0.95"],
  },
};

const PAGES = [
  // Page 1 — no cursor (first page)
  `${BASE_URL}/api/arenas?limit=25`,
  // Page 2 — a cursor value that a real server would return; in a load-test
  // context we just want to exercise the cursor-parsing code path, so a
  // syntactically valid base64url-encoded offset is sufficient even if it
  // points past the end of real data (the handler returns an empty items[]).
  `${BASE_URL}/api/arenas?limit=25&cursor=eyJvZmZzZXQiOjI1fQ`,
];

export default function () {
  // Distribute requests across the two page variants.
  const url = PAGES[Math.floor(Math.random() * PAGES.length)];
  const res = http.get(url, { headers: commonHeaders() });

  const ok = check(res, {
    "status is 200": (r) => r.status === 200,
    "body is JSON": (r) => {
      try {
        JSON.parse(r.body);
        return true;
      } catch {
        return false;
      }
    },
    "items array present": (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.items);
      } catch {
        return false;
      }
    },
  });

  validResponseRate.add(ok);

  // Minimal think-time to avoid thundering-herd at VU startup.
  sleep(0.05);
}
