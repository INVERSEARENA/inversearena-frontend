import { Registry, Counter, Histogram, Gauge } from 'prom-client';
import type { PrismaClient } from '@prisma/client';

export const register = new Registry();

// HTTP Metrics
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

// Worker Metrics
export const workerJobsPending = new Gauge({
  name: 'worker_jobs_pending',
  help: 'Number of pending worker jobs',
  labelNames: ['job_type'],
  registers: [register],
});

// Transaction Metrics
export const txsConfirmedTotal = new Counter({
  name: 'txs_confirmed_total',
  help: 'Total number of confirmed transactions',
  labelNames: ['status'],
  registers: [register],
});

// Round Metrics
export const roundResolutionsTotal = new Counter({
  name: 'round_resolutions_total',
  help: 'Total number of round resolutions',
  labelNames: ['status'],
  registers: [register],
});

export const roundResolutionDuration = new Histogram({
  name: 'round_resolution_duration_seconds',
  help: 'Round resolution duration in seconds',
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const arenaStateTransitionsTotal = new Counter({
  name: 'inversearena_arena_state_transitions_total',
  help: 'Total number of arena round state transitions',
  labelNames: ['from_state', 'to_state'],
  registers: [register],
});

export const arenasActiveGauge = new Gauge({
  name: 'inversearena_arenas_active_total',
  help: 'Number of arenas with an unresolved active round',
  registers: [register],
});

export const playersEliminatedTotal = new Counter({
  name: 'inversearena_players_eliminated_total',
  help: 'Total players eliminated across all arenas',
  registers: [register],
});

export const payoutsSuccessTotal = new Counter({
  name: 'inversearena_payouts_success_total',
  help: 'Total successful prize payouts',
  labelNames: ['asset'],
  registers: [register],
});

export const payoutsDeadLetterTotal = new Counter({
  name: 'inversearena_payouts_dead_letter_total',
  help: 'Total payouts moved to dead status after exhausting failed retries',
  labelNames: ['reason'],
  registers: [register],
});

// 0 = closed (healthy), 1 = half-open (probing), 2 = open (failing)
export const sorobanCircuitBreakerState = new Gauge({
  name: 'inversearena_soroban_circuit_breaker_state',
  help: 'Soroban RPC circuit breaker state: 0=closed, 1=half-open, 2=open',
  registers: [register],
});

export const sorobanCircuitTransitionsTotal = new Counter({
  name: 'inversearena_soroban_circuit_transitions_total',
  help: 'Total Soroban RPC circuit breaker state transitions',
  labelNames: ['to_state'],
  registers: [register],
});

// ── Issue #1411 — Active stake limits ────────────────────────────────────────

export const activeStakeLimitBlockedTotal = new Counter({
  name: 'inversearena_active_stake_limit_blocked_total',
  help: 'Total join attempts blocked by the aggregate active stake limit',
  labelNames: ['reason'],
  registers: [register],
});

export const activeStakeCurrentGauge = new Gauge({
  name: 'inversearena_active_stake_current',
  help: 'Current active stake in USDC-equivalent units for a player (sampled at join time)',
  labelNames: ['user_id'],
  registers: [register],
});

// ── Issue #1412 — Arena health summary ───────────────────────────────────────

export const arenaHealthGauge = new Gauge({
  name: 'inversearena_arena_health_status',
  help: 'Composite arena health: 0=healthy, 1=degraded, 2=critical',
  labelNames: ['arena_id'],
  registers: [register],
});

export const arenaChainLagGauge = new Gauge({
  name: 'inversearena_arena_chain_lag_seconds',
  help: 'Seconds since the arena was last confirmed on-chain',
  labelNames: ['arena_id'],
  registers: [register],
});

export const arenaQueueLagGauge = new Gauge({
  name: 'inversearena_arena_queue_lag_seconds',
  help: 'Age in seconds of the oldest queued/submitted payout for the arena',
  labelNames: ['arena_id'],
  registers: [register],
});

export const arenaStateDriftGauge = new Gauge({
  name: 'inversearena_arena_state_drift_seconds',
  help: 'Seconds the arena has spent in the current round state beyond the expected TTL',
  labelNames: ['arena_id', 'state'],
  registers: [register],
});

// ── Issue #1413 — Fee sponsorship ─────────────────────────────────────────────

export const feeEligibilityIssuedTotal = new Counter({
  name: 'inversearena_fee_eligibility_issued_total',
  help: 'Total fee sponsorship eligibility tokens issued to winners',
  registers: [register],
});

export const feeEligibilityConsumedTotal = new Counter({
  name: 'inversearena_fee_eligibility_consumed_total',
  help: 'Total fee sponsorship eligibility tokens consumed on claim',
  registers: [register],
});

export const feeEligibilityExpiredTotal = new Counter({
  name: 'inversearena_fee_eligibility_expired_total',
  help: 'Total fee sponsorship eligibility tokens expired unused',
  registers: [register],
});

// ── Issue #1414 — Player aliases ──────────────────────────────────────────────

export const aliasUpdateTotal = new Counter({
  name: 'inversearena_alias_update_total',
  help: 'Total alias update attempts',
  labelNames: ['result'],
  registers: [register],
});

export async function refreshArenaMetrics(prisma: PrismaClient): Promise<void> {
  const activeRounds = await prisma.round.findMany({
    where: {
      state: {
        in: ['OPEN', 'CLOSED'],
      },
    },
    distinct: ['arenaId'],
    select: { arenaId: true },
  });

  arenasActiveGauge.set(activeRounds.length);
}
