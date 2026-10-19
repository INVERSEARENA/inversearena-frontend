/**
 * Checkpointed replay engine for the canonical arena projection (#1382).
 *
 * Orchestrates: claim lease → load checkpoint-or-genesis → fetch paginated
 * event batches via onChainReader.getArenaEvents → fold each batch with the
 * canonical `foldArenaProjectionEvents` → persist the checkpoint after EACH
 * batch → repeat until caught up → release lease.
 *
 * This module owns I/O and orchestration only. It must never re-implement
 * fold logic — see docs/projection-checkpoint-replay.md.
 */

import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { getArenaEvents, OnChainReadError } from "../onChainReader";
import { getStellarConfig } from "../../config/stellarConfig";
import { logger } from "../../utils/logger";
import {
  ArenaProjectionCheckpointStore,
  LeaseHeldError,
  type ArenaProjectionCheckpointStatus,
} from "./arenaProjectionCheckpointStore";
import {
  foldArenaProjectionEvents,
  initialArenaProjection,
  type ArenaProjectionState,
} from "./arenaProjectionFold";
import {
  projectionEventsFoldedTotal,
  projectionLeaseConflictsTotal,
  projectionReplayBatchesTotal,
  projectionReplayDurationSeconds,
  projectionReplayRetriesTotal,
  projectionReplayTotal,
} from "./arenaProjectionMetrics";

const SUBSYSTEM = "arena-projection";

/** Default lease TTL — renewed after each batch, so a crashed holder's lease expires quickly. */
export const DEFAULT_LEASE_MS = 60_000;

/** Default page size per `getEvents` RPC call — bounds memory per batch. */
export const DEFAULT_BATCH_SIZE = 1000;

/** Default RPC retry attempts for a single batch fetch before giving up. */
export const DEFAULT_MAX_RETRIES = 3;
const RETRY_BACKOFF_BASE_MS = 250;

export interface ArenaReplayResult {
  arenaId: string;
  network: string;
  status: ArenaProjectionCheckpointStatus;
  state: ArenaProjectionState;
  batchesProcessed: number;
  eventsProcessed: number;
}

export interface ArenaReplayOptions {
  batchSize?: number;
  leaseMs?: number;
  maxRetries?: number;
  /** Genesis ledger to start from when no checkpoint exists yet. Required for a first-ever replay. */
  genesisLedger?: number;
  /** Override the sleep function used between retries (test seam). */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch one batch of events, retrying transient RPC failures with linear
 * backoff. Retries are counted via `projectionReplayRetriesTotal` so
 * sustained flakiness is visible in metrics before it becomes a `failed`
 * replay.
 */
async function fetchBatchWithRetry(
  contractId: string,
  pagination: { startLedger: number } | { cursor: string },
  batchSize: number,
  maxRetries: number,
  sleep: (ms: number) => Promise<void>,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await getArenaEvents(contractId, pagination as never, batchSize);
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        projectionReplayRetriesTotal.inc();
        logger.warn(
          { subsystem: SUBSYSTEM, contractId, attempt, maxRetries },
          "Transient failure fetching arena event batch, retrying",
        );
        await sleep(RETRY_BACKOFF_BASE_MS * 2 ** attempt);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new OnChainReadError("getEvents", contractId, lastError);
}

/**
 * Replay an arena's on-chain event log into its canonical projection,
 * resuming from a checkpoint if one exists (or from `options.genesisLedger`
 * otherwise). Persists a checkpoint after each batch, so an interrupted
 * replay resumes from the last fully-folded batch rather than restarting
 * from scratch or losing progress (see docs/projection-checkpoint-replay.md).
 *
 * @throws LeaseHeldError if another process is currently replaying this
 *   arena on this network.
 * @throws CorruptCheckpointError if the stored checkpoint can't be trusted.
 * @throws Error (network/RPC) if a batch fails after exhausting retries —
 *   the checkpoint is left at the last successfully-committed position.
 */
export async function replayArenaProjection(
  prisma: PrismaClient,
  arenaId: string,
  options: ArenaReplayOptions = {},
): Promise<ArenaReplayResult> {
  const {
    batchSize = DEFAULT_BATCH_SIZE,
    leaseMs = DEFAULT_LEASE_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    genesisLedger,
    sleep = defaultSleep,
  } = options;

  const network = getStellarConfig().networkPassphrase;
  const store = new ArenaProjectionCheckpointStore(prisma);
  const leaseOwner = randomUUID();
  const endTimer = projectionReplayDurationSeconds.startTimer();

  let lease: string;
  try {
    lease = await store.claimLease(arenaId, network, leaseMs, leaseOwner);
  } catch (error) {
    if (error instanceof LeaseHeldError) {
      projectionLeaseConflictsTotal.inc();
      logger.warn(
        { subsystem: SUBSYSTEM, arenaId, network, heldBy: error.heldBy },
        "Projection replay lease held by another process; skipping this run",
      );
    }
    endTimer();
    throw error;
  }

  logger.info({ subsystem: SUBSYSTEM, arenaId, network }, "Starting arena projection replay");

  let state: ArenaProjectionState;
  const existingCheckpoint = await store.load(arenaId, network);
  if (existingCheckpoint) {
    state = existingCheckpoint.projectionState;
  } else {
    if (genesisLedger === undefined) {
      await store.releaseLease(arenaId, network, lease);
      endTimer();
      throw new Error(
        `No checkpoint exists for arena ${arenaId} on ${network} and no genesisLedger was provided`,
      );
    }
    state = initialArenaProjection(arenaId);
  }

  let batchesProcessed = 0;
  let eventsProcessed = 0;

  try {
    let pagination: { startLedger: number } | { cursor: string } =
      state.lastLedgerSequence !== null
        ? { startLedger: state.lastLedgerSequence + 1 }
        : { startLedger: genesisLedger as number };

    for (;;) {
      const batchStart = Date.now();
      let page;
      try {
        page = await fetchBatchWithRetry(arenaId, pagination, batchSize, maxRetries, sleep);
      } catch (error) {
        projectionReplayBatchesTotal.inc({ result: "failure" });
        const message = error instanceof Error ? error.message : String(error);
        await store.markFailed(arenaId, network, message);
        logger.error(
          { subsystem: SUBSYSTEM, arenaId, network, err: message },
          "Arena projection replay batch failed; checkpoint left at last good position",
        );
        projectionReplayTotal.inc({ result: "failure" });
        throw error;
      }

      state = foldArenaProjectionEvents(state, page.events);
      for (const event of page.events) {
        projectionEventsFoldedTotal.inc({ topic: event.topic });
      }

      const isCaughtUp = page.cursor === null;
      await store.save(arenaId, network, state, isCaughtUp ? "caught_up" : "replaying");
      await store.renewLease(arenaId, network, lease, leaseMs);

      batchesProcessed += 1;
      eventsProcessed += page.events.length;
      projectionReplayBatchesTotal.inc({ result: "success" });

      logger.info(
        {
          subsystem: SUBSYSTEM,
          arenaId,
          network,
          batchEventCount: page.events.length,
          lastLedgerSequence: state.lastLedgerSequence,
          durationMs: Date.now() - batchStart,
          caughtUp: isCaughtUp,
        },
        "Arena projection replay batch committed",
      );

      if (isCaughtUp) break;
      pagination = { cursor: page.cursor as string };
    }

    await store.releaseLease(arenaId, network, lease);
    projectionReplayTotal.inc({ result: "success" });
    logger.info(
      { subsystem: SUBSYSTEM, arenaId, network, batchesProcessed, eventsProcessed },
      "Arena projection replay caught up",
    );

    return {
      arenaId,
      network,
      status: "caught_up",
      state,
      batchesProcessed,
      eventsProcessed,
    };
  } catch (error) {
    await store.releaseLease(arenaId, network, lease);
    throw error;
  } finally {
    endTimer();
  }
}
