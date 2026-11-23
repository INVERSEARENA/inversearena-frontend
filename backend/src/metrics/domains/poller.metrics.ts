/**
 * Poller & Arena Stream Metrics Domain (#1750)
 */

import type { PrismaClient } from "@prisma/client";
import {
  createCounter,
  createGauge,
  createHistogram,
} from "../registry";

export const arenasActiveGauge = createGauge(
  {
    name: "inversearena_arenas_active_total",
    help: "Number of arenas with an unresolved active round",
  },
  { domain: "poller" },
);

// #1500: publish arena stream updates only when verified state changes
export const arenaPollsTotal = createCounter(
  {
    name: "inversearena_arena_polls_total",
    help: "Arena poller fetch+verify attempts, by outcome (ok/error)",
    labelNames: ["outcome"],
  },
  { domain: "poller" },
);

export const arenaSemanticChangesTotal = createCounter(
  {
    name: "inversearena_arena_semantic_changes_total",
    help: "Arena polls whose canonical snapshot fingerprint changed and were published",
  },
  { domain: "poller" },
);

export const arenaSuppressedPublishesTotal = createCounter(
  {
    name: "inversearena_arena_suppressed_publishes_total",
    help: "Arena polls with unchanged verified state where publication was suppressed",
  },
  { domain: "poller" },
);

export const arenaStreamResyncsTotal = createCounter(
  {
    name: "inversearena_arena_stream_resyncs_total",
    help: "Client-requested arena stream full-snapshot resynchronisations, by reason",
    labelNames: ["reason"],
  },
  { domain: "poller" },
);

export const arenaStreamUpdateBytesTotal = createCounter(
  {
    name: "inversearena_arena_stream_update_bytes_total",
    help: "JSON bytes published on the arena stream, by envelope kind (snapshot or delta) (#1767)",
    labelNames: ["kind"],
  },
  { domain: "poller" },
);

// #1433: Bounded concurrency & backpressure metrics for arena poller
export const arenaPollerActivePollsGauge = createGauge(
  {
    name: "inversearena_arena_poller_active_polls",
    help: "Number of active in-flight arena poll operations",
  },
  { domain: "poller" },
);

export const arenaPollerQueueDepthGauge = createGauge(
  {
    name: "inversearena_arena_poller_queue_depth",
    help: "Number of pending arena poll requests queued under backpressure",
  },
  { domain: "poller" },
);

export const arenaPollerBackpressureShedTotal = createCounter(
  {
    name: "inversearena_arena_poller_backpressure_shed_total",
    help: "Total arena polls shed or dropped due to queue saturation backpressure",
    labelNames: ["reason"],
  },
  { domain: "poller" },
);

export const arenaPollerPollDurationSeconds = createHistogram(
  {
    name: "inversearena_arena_poller_poll_duration_seconds",
    help: "Duration of arena poll operations in seconds",
    labelNames: ["outcome"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  },
  { domain: "poller" },
);

export const arenaPollerRetriesTotal = createCounter(
  {
    name: "inversearena_arena_poller_retries_total",
    help: "Total poller retry attempts following execution errors, by reason",
    labelNames: ["reason"],
  },
  { domain: "poller" },
);

// #1524: Adaptive Arena Polling Cadence & Priority Metrics
export const arenaPollerCadenceSeconds = createHistogram(
  {
    name: "inversearena_arena_poller_cadence_seconds",
    help: "Observed or scheduled polling interval cadence in seconds by arena state",
    labelNames: ["state"],
    buckets: [0.1, 0.5, 1, 2.5, 5, 10, 15, 30, 60],
  },
  { domain: "poller" },
);

export const arenaPollerWakeTotal = createCounter(
  {
    name: "inversearena_arena_poller_wake_total",
    help: "Total poller wake triggers by reason",
    labelNames: ["reason"],
  },
  { domain: "poller" },
);

export const arenaPollerLatenessMs = createHistogram(
  {
    name: "inversearena_arena_poller_lateness_ms",
    help: "Lateness of scheduled poll execution against deadline in milliseconds",
    buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 5000],
  },
  { domain: "poller" },
);

export const arenaPollerSkippedTotal = createCounter(
  {
    name: "inversearena_arena_poller_skipped_total",
    help: "Total polls skipped due to circuit breaker, concurrency limit or maintenance",
    labelNames: ["reason"],
  },
  { domain: "poller" },
);

export const arenaPollerActiveArenasGauge = createGauge(
  {
    name: "inversearena_arena_poller_active_arenas",
    help: "Active arenas tracked by adaptive scheduler by lifecycle state",
    labelNames: ["lifecycle_state"],
  },
  { domain: "poller" },
);

export async function refreshArenaMetrics(prisma: PrismaClient): Promise<void> {
  const activeRounds = await prisma.round.findMany({
    where: {
      state: {
        in: ["OPEN", "CLOSED"],
      },
    },
    distinct: ["arenaId"],
    select: { arenaId: true },
  });

  arenasActiveGauge.set(activeRounds.length);
}
