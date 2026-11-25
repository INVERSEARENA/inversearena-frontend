/**
 * Prometheus metrics for the checkpointed arena projection replay path
 * (#1382). Registered on the shared prom-client Registry
 * (`backend/src/utils/metrics.ts`) so they're served by the existing
 * `/metrics` endpoint alongside round/payout metrics.
 *
 * See docs/projection-checkpoint-replay.md, "Metrics / structured logs".
 */

import { Counter, Histogram } from "prom-client";
import { register } from "../../utils/metrics";

export const projectionReplayTotal = new Counter({
  name: "inversearena_projection_replay_total",
  help: "Total projection replay runs, by outcome",
  labelNames: ["result"] as const,
  registers: [register],
});

export const projectionReplayDurationSeconds = new Histogram({
  name: "inversearena_projection_replay_duration_seconds",
  help: "Duration of a full replay run (genesis-or-checkpoint through caught_up/failure)",
  buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
});

export const projectionReplayBatchesTotal = new Counter({
  name: "inversearena_projection_replay_batches_total",
  help: "Total replay batches processed, by outcome",
  labelNames: ["result"] as const,
  registers: [register],
});

export const projectionReplayRetriesTotal = new Counter({
  name: "inversearena_projection_replay_retries_total",
  help: "Total RPC retry attempts made while fetching a batch of events",
  registers: [register],
});

export const projectionEventsFoldedTotal = new Counter({
  name: "inversearena_projection_events_folded_total",
  help: "Total events folded into arena projections, by topic (including UNKNOWN)",
  labelNames: ["topic"] as const,
  registers: [register],
});

export const projectionLeaseConflictsTotal = new Counter({
  name: "inversearena_projection_lease_conflicts_total",
  help: "Total replay attempts that found an active lease held by another process",
  registers: [register],
});
