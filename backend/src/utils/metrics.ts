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
