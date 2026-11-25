# k6 Load-Test Suite — Arena APIs & SSE Streams

> Issue [#1624](https://github.com/your-org/inversearena-frontend/issues/1624)

This directory contains a [k6](https://k6.io) load-test suite that models the
three traffic patterns that stress-test arena capacity at round boundaries:

| Scenario | File | Acceptance criterion |
|---|---|---|
| Lobby browse | `scenarios/arena-list.js` | 200 RPS against `GET /api/arenas`, p95 < 500 ms, error rate < 1 % |
| Live SSE subscribers | `scenarios/sse-subscribers.js` | 1 000 concurrent connections to one arena, p95 time-to-first-event < 1 000 ms |
| Round-boundary burst | `scenarios/round-boundary-burst.js` | 500 `GET /api/arenas/:id` reads completed in ≤ 5 s, p95 < 500 ms |

All three scenarios are combined in **`suite.js`** for CI and baseline comparison.

---

## Directory layout

```
backend/tests/load/
├── suite.js                        # Full suite (all scenarios, all thresholds)
├── compare-baseline.js             # Node script: diff latest run vs baseline
├── compare-baseline.unit.test.ts   # Unit tests for the comparator
├── README.md                       # This file
├── lib/
│   ├── env.js                      # Shared ENV helpers (BASE_URL, ARENA_ID …)
│   └── thresholds.js               # Shared threshold constants
├── scenarios/
│   ├── arena-list.js               # Scenario A: 200 RPS arena list
│   ├── sse-subscribers.js          # Scenario B: 1 000 SSE connections
│   └── round-boundary-burst.js     # Scenario C: 500 reads in 5 s
└── baselines/
    ├── baseline.json               # Committed baseline (updated intentionally)
    └── latest.json                 # Git-ignored output of the most recent run
```

---

## Prerequisites

- [k6](https://k6.io/docs/get-started/installation/) installed (`brew install k6` / `choco install k6` / [Linux packages](https://dl.k6.io))
- A running backend pointed at a Postgres + Redis instance
- A seeded arena ID (see below)

---

## Running locally

### 1. Start the infrastructure

```bash
# From repo root
make infra          # or: docker-compose -f backend/docker-compose.yml up -d
```

### 2. Start the backend

```bash
cd backend
cp .env.example .env          # fill in DATABASE_URL, REDIS_URL, JWT_SECRET …
# Raise SSE connection limits so k6 loopback VUs aren't rejected immediately:
export SSE_MAX_CONNECTIONS_PER_IP=1100
export SSE_MAX_CONNECTIONS_PER_ARENA=1100
# Optional: enable rate-limit bypass for load-test VUs
export LOAD_TEST_BYPASS_KEY=k6-load-test-local
npm run dev
```

### 3. Obtain an arena ID

Either create one via the API or read one from the database:

```bash
psql "$DATABASE_URL" -c "SELECT id FROM \"Arena\" LIMIT 1;"
```

### 4. Run the full suite

```bash
k6 run \
  -e BASE_URL=http://localhost:3001 \
  -e ARENA_ID=<your-arena-id> \
  -e AUTH_TOKEN=<your-jwt> \
  -e BYPASS_RATE_LIMIT=1 \
  -e LOAD_TEST_SECRET_KEY=k6-load-test-local \
  --out json=backend/tests/load/baselines/latest.json \
  backend/tests/load/suite.js
```

### 5. Run individual scenarios

```bash
# Arena list browse only
k6 run -e BASE_URL=http://localhost:3001 \
       backend/tests/load/scenarios/arena-list.js

# SSE subscribers only
k6 run -e BASE_URL=http://localhost:3001 \
       -e ARENA_ID=<id> -e AUTH_TOKEN=<jwt> \
       backend/tests/load/scenarios/sse-subscribers.js

# Round-boundary burst only
k6 run -e BASE_URL=http://localhost:3001 \
       -e ARENA_ID=<id> \
       backend/tests/load/scenarios/round-boundary-burst.js
```

### 6. Compare against the stored baseline

```bash
node backend/tests/load/compare-baseline.js \
  backend/tests/load/baselines/baseline.json \
  backend/tests/load/baselines/latest.json
```

Exits **0** if all metrics are within tolerance, **1** if any regress.

### 7. Update the baseline

After a deliberate capacity or performance improvement:

```bash
cp backend/tests/load/baselines/latest.json \
   backend/tests/load/baselines/baseline.json
git add backend/tests/load/baselines/baseline.json
git commit -m "chore(load): update k6 baseline after capacity improvement"
```

---

## CI (GitHub Actions)

The workflow at `.github/workflows/load-test.yml` runs on **manual dispatch only**
(`workflow_dispatch`) so it never blocks PR merges.

Trigger it from **Actions → Load Tests (k6) → Run workflow** with optional inputs:

| Input | Default | Description |
|---|---|---|
| `base_url` | `http://localhost:3001` | API base URL |
| `arena_id` | *(auto-seeded)* | Arena to use for SSE/state-read scenarios |
| `sse_dwell_seconds` | `15` | How long each SSE VU holds its connection |
| `update_baseline` | `false` | Set `true` to overwrite the stored baseline artifact |

Results are uploaded as GitHub Actions artifacts with a 90-day retention period.
The baseline artifact is retained for 365 days and is downloaded at the start of
each run so regressions are detected across separate workflow runs.

---

## Rate-limiter bypass

When running k6 locally or in CI, all VUs originate from the same IP
(`127.0.0.1`), which immediately exhausts `SSE_MAX_CONNECTIONS_PER_IP`.

Two mitigations are available — use either or both:

### Option A — Raise the per-IP SSE limit

```bash
SSE_MAX_CONNECTIONS_PER_IP=1100 SSE_MAX_CONNECTIONS_PER_ARENA=1100 npm run dev
```

### Option B — Enable the load-test bypass header

Start the backend with a shared secret:

```bash
LOAD_TEST_BYPASS_KEY=k6-load-test-local npm run dev
```

Pass the same secret to k6:

```bash
k6 run -e BYPASS_RATE_LIMIT=1 -e LOAD_TEST_SECRET_KEY=k6-load-test-local …
```

The `createLoadTestBypassMiddleware` sets `req.__loadTestBypass = true` when the
`X-Load-Test-Key` header matches, and `createRateLimitMiddleware` skips counting
for those requests.  The middleware is a **complete no-op** when
`LOAD_TEST_BYPASS_KEY` is unset (the default in production).

---

## Thresholds

All thresholds are defined in `lib/thresholds.js` and enforced by k6 at run
time.  k6 exits non-zero if any threshold is violated, failing the CI job.

| Metric | Threshold |
|---|---|
| `http_req_duration` p95 | < 500 ms |
| `http_req_failed` rate | < 1 % |
| `sse_time_to_first_event` p95 | < 1 000 ms |
| `sse_connect_errors` rate | < 1 % |
| `arena_list_valid_response` rate | > 95 % |
| `arena_state_duration` p95 | < 500 ms |
| `burst_reads_completed` count | ≥ 500 |

---

## Baseline comparison tolerances

The `compare-baseline.js` script allows a per-metric regression tolerance
before flagging a failure.  Current tolerances:

| Metric | Direction | Tolerance |
|---|---|---|
| `http_req_duration` p95 | lower is better | 10 % |
| `http_req_failed` rate | lower is better | 0.5 pp |
| `sse_time_to_first_event` p95 | lower is better | 10 % |
| `sse_connect_errors` rate | lower is better | 0.5 pp |
| `arena_list_valid_response` rate | higher is better | 2 pp |
| `arena_state_duration` p95 | lower is better | 10 % |
| `burst_reads_completed` count | higher is better | 0 % |
