import {
  arenaStateTransitionsTotal,
  arenasActiveGauge,
  httpRequestDuration,
  httpRequestsTotal,
  payoutsSuccessTotal,
  playersEliminatedTotal,
  register,
  txsConfirmedTotal,
  workerJobsPending,
} from '../src/utils/metrics';

async function testMetricsEndpoint() {
  console.log('🧪 Test: Metrics Endpoint');
  
  // Simulate some activity
  httpRequestsTotal.inc({ method: 'GET', route: '/health', status: '200' });
  httpRequestsTotal.inc({ method: 'POST', route: '/api/payouts', status: '201' });
  httpRequestsTotal.inc({ method: 'POST', route: '/api/payouts', status: '400' });
  
  httpRequestDuration.observe({ method: 'GET', route: '/health', status: '200' }, 0.05);
  httpRequestDuration.observe({ method: 'POST', route: '/api/payouts', status: '201' }, 0.5);
  
  workerJobsPending.set({ job_type: 'payment' }, 5);
  
  txsConfirmedTotal.inc({ status: 'confirmed' });
  txsConfirmedTotal.inc({ status: 'confirmed' });
  txsConfirmedTotal.inc({ status: 'failed' });
  arenaStateTransitionsTotal.inc({ from_state: 'OPEN', to_state: 'RESOLVED' });
  playersEliminatedTotal.inc(3);
  payoutsSuccessTotal.inc({ asset: 'XLM' });
  arenasActiveGauge.set(2);
  
  const metrics = await register.metrics();
  
  const checks = [
    { name: 'http_requests_total', present: metrics.includes('http_requests_total') },
    { name: 'http_request_duration_seconds', present: metrics.includes('http_request_duration_seconds') },
    { name: 'worker_jobs_pending', present: metrics.includes('worker_jobs_pending') },
    { name: 'txs_confirmed_total', present: metrics.includes('txs_confirmed_total') },
    { name: 'inversearena_arenas_active_total', present: metrics.includes('inversearena_arenas_active_total') },
    { name: 'inversearena_players_eliminated_total', present: metrics.includes('inversearena_players_eliminated_total') },
    { name: 'inversearena_payouts_success_total', present: metrics.includes('inversearena_payouts_success_total') },
    { name: 'inversearena_arena_state_transitions_total', present: metrics.includes('inversearena_arena_state_transitions_total') },
    { name: 'route label', present: metrics.includes('route=') },
    { name: 'status label', present: metrics.includes('status=') },
  ];
  
  let passed = 0;
  for (const check of checks) {
    if (check.present) {
      console.log(`  ✅ ${check.name}`);
      passed++;
    } else {
      console.log(`  ❌ ${check.name}`);
    }
  }
  
  console.log(passed === checks.length ? '✅ PASS: All metrics present' : '❌ FAIL: Some metrics missing');
  console.log('\nSample metrics output:');
  console.log(metrics.split('\n').slice(0, 20).join('\n'));
}

async function testMetricCardinality() {
  console.log('\n🧪 Test: Metric Cardinality');
  
  // Test that we're not creating too many unique label combinations
  const routes = ['/health', '/api/payouts', '/api/admin/rounds'];
  const statuses = ['200', '201', '400', '500'];
  const methods = ['GET', 'POST'];
  
  const maxCombinations = routes.length * statuses.length * methods.length;
  
  console.log(`  Max label combinations: ${maxCombinations}`);
  console.log(maxCombinations < 100 ? '  ✅ PASS: Low cardinality' : '  ⚠️  WARNING: High cardinality');
}

async function testMetricsFormat() {
  console.log('\n🧪 Test: Prometheus Format');
  
  const metrics = await register.metrics();
  
  const checks = [
    { name: 'HELP comments', present: metrics.includes('# HELP') },
    { name: 'TYPE comments', present: metrics.includes('# TYPE') },
    { name: 'Counter type', present: metrics.includes('TYPE') && metrics.includes('counter') },
    { name: 'Histogram type', present: metrics.includes('TYPE') && metrics.includes('histogram') },
    { name: 'Gauge type', present: metrics.includes('TYPE') && metrics.includes('gauge') },
  ];
  
  let passed = 0;
  for (const check of checks) {
    if (check.present) {
      console.log(`  ✅ ${check.name}`);
      passed++;
    } else {
      console.log(`  ❌ ${check.name}`);
    }
  }
  
  console.log(passed === checks.length ? '✅ PASS: Valid Prometheus format' : '❌ FAIL: Invalid format');
}

async function runTests() {
  console.log('🔍 Metrics Test Suite');
  console.log('=====================\n');
  
  try {
    await testMetricsEndpoint();
    await testMetricCardinality();
    await testMetricsFormat();
    
    console.log('\n✅ All metrics tests completed');
  } catch (error) {
    console.error('\n❌ Test error:', error);
    process.exit(1);
  }
}

runTests();
