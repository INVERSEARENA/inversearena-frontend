/**
 * K6 Load Test: Connection Pooling Performance
 * 
 * Tests database connection pool performance under load
 * Compare before/after PgBouncer implementation
 * 
 * Run: k6 run --vus 50 --duration 60s load-tests/connection-pooling.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const dbWaitTime = new Trend('db_wait_time');
const requestDuration = new Trend('request_duration');

// Test configuration
export const options = {
  stages: [
    { duration: '30s', target: 20 },  // Ramp up to 20 users
    { duration: '1m', target: 50 },   // Ramp up to 50 users
    { duration: '2m', target: 50 },   // Stay at 50 users
    { duration: '1m', target: 100 },  // Spike to 100 users
    { duration: '1m', target: 100 },  // Stay at 100 users
    { duration: '30s', target: 0 },   // Ramp down to 0
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'], // 95% < 500ms, 99% < 1s
    http_req_failed: ['rate<0.05'],                  // Error rate < 5%
    errors: ['rate<0.05'],
    db_wait_time: ['p(95)<100', 'p(99)<200'],       // Pool wait time thresholds
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';

// Test scenarios covering different database operations

export default function () {
  const scenarios = [
    testArenaList,
    testLeaderboard,
    testUserProfile,
    testTransactions,
    testRoundData,
  ];

  // Randomly pick a scenario
  const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];
  scenario();

  // Think time between requests (100-300ms)
  sleep(Math.random() * 0.2 + 0.1);
}

/**
 * Test 1: Arena List (simple read)
 */
function testArenaList() {
  const start = Date.now();
  const res = http.get(`${BASE_URL}/api/arenas`);
  const duration = Date.now() - start;

  const success = check(res, {
    'arena list status 200': (r) => r.status === 200,
    'arena list has data': (r) => {
      try {
        const json = JSON.parse(r.body);
        return Array.isArray(json) || Array.isArray(json.data);
      } catch {
        return false;
      }
    },
  });

  errorRate.add(!success);
  requestDuration.add(duration);
  
  if (res.headers['X-Db-Wait-Time']) {
    dbWaitTime.add(parseFloat(res.headers['X-Db-Wait-Time']));
  }
}

/**
 * Test 2: Leaderboard (aggregation query)
 */
function testLeaderboard() {
  const start = Date.now();
  const res = http.get(`${BASE_URL}/api/leaderboard?limit=50`);
  const duration = Date.now() - start;

  const success = check(res, {
    'leaderboard status 200': (r) => r.status === 200,
    'leaderboard has rankings': (r) => {
      try {
        const json = JSON.parse(r.body);
        return json.rankings || json.data;
      } catch {
        return false;
      }
    },
  });

  errorRate.add(!success);
  requestDuration.add(duration);
  
  if (res.headers['X-Db-Wait-Time']) {
    dbWaitTime.add(parseFloat(res.headers['X-Db-Wait-Time']));
  }
}

/**
 * Test 3: User Profile (relational read)
 */
function testUserProfile() {
  // Use a test wallet address
  const testWallet = `G${'A'.repeat(55)}`;
  
  const start = Date.now();
  const res = http.get(`${BASE_URL}/api/users/${testWallet}`);
  const duration = Date.now() - start;

  const success = check(res, {
    'profile status is valid': (r) => r.status === 200 || r.status === 404,
  });

  errorRate.add(!success);
  requestDuration.add(duration);
  
  if (res.headers['X-Db-Wait-Time']) {
    dbWaitTime.add(parseFloat(res.headers['X-Db-Wait-Time']));
  }
}

/**
 * Test 4: Transaction History (pagination)
 */
function testTransactions() {
  const page = Math.floor(Math.random() * 5) + 1;
  
  const start = Date.now();
  const res = http.get(`${BASE_URL}/api/transactions?page=${page}&limit=20`);
  const duration = Date.now() - start;

  const success = check(res, {
    'transactions status 200': (r) => r.status === 200,
  });

  errorRate.add(!success);
  requestDuration.add(duration);
  
  if (res.headers['X-Db-Wait-Time']) {
    dbWaitTime.add(parseFloat(res.headers['X-Db-Wait-Time']));
  }
}

/**
 * Test 5: Round Data (complex join)
 */
function testRoundData() {
  const arenaId = `test-arena-${Math.floor(Math.random() * 10)}`;
  
  const start = Date.now();
  const res = http.get(`${BASE_URL}/api/arenas/${arenaId}/rounds/current`);
  const duration = Date.now() - start;

  const success = check(res, {
    'round data status is valid': (r) => r.status === 200 || r.status === 404,
  });

  errorRate.add(!success);
  requestDuration.add(duration);
  
  if (res.headers['X-Db-Wait-Time']) {
    dbWaitTime.add(parseFloat(res.headers['X-Db-Wait-Time']));
  }
}

/**
 * Teardown: print summary
 */
export function handleSummary(data) {
  console.log('\n=== Load Test Summary ===');
  console.log(`Total Requests: ${data.metrics.http_reqs.values.count}`);
  console.log(`Failed Requests: ${data.metrics.http_req_failed.values.rate * 100}%`);
  console.log(`P95 Response Time: ${data.metrics.http_req_duration.values['p(95)']}ms`);
  console.log(`P99 Response Time: ${data.metrics.http_req_duration.values['p(99)']}ms`);
  
  if (data.metrics.db_wait_time) {
    console.log(`P95 DB Wait Time: ${data.metrics.db_wait_time.values['p(95)']}ms`);
    console.log(`P99 DB Wait Time: ${data.metrics.db_wait_time.values['p(99)']}ms`);
  }

  return {
    'summary.json': JSON.stringify(data, null, 2),
  };
}
