/**
 * Checkpoint persistence for the canonical arena projection (#1382).
 *
 * Backed by the `ArenaProjectionCheckpoint` Prisma model. One row per
 * `(arenaId, network)` — network-scoped so testnet and mainnet checkpoints
 * for the same arena contract ID (which cannot collide in practice, but
 * defensively) never mix. See docs/projection-checkpoint-replay.md.
 *
 * This module owns *storage* of checkpoints and the advisory lease used to
 * guard against concurrent replay processes. It does not fold events or
 * decide replay batching — that's `arenaProjectionReplay.ts`.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { initialArenaProjection, type ArenaProjectionState } from "./arenaProjectionFold";

export type ArenaProjectionCheckpointStatus =
  | "idle"
  | "replaying"
  | "caught_up"
  | "failed";

export interface ArenaProjectionCheckpointRecord {
  arenaId: string;
  network: string;
  lastLedgerSequence: number;
  projectionState: ArenaProjectionState;
  status: ArenaProjectionCheckpointStatus;
  lastError: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  updatedAt: Date;
}

/**
 * Raised when a checkpoint row exists but its `projectionState` JSON does
 * not match the expected `ArenaProjectionState` shape. Deliberately NOT
 * silently treated as "no checkpoint" (which would replay from genesis
 * under a state the caller didn't ask for) — see design note, "Failure
 * behavior: corrupted/missing checkpoint row".
 */
export class CorruptCheckpointError extends Error {
  constructor(
    readonly arenaId: string,
    readonly network: string,
    reason: string,
  ) {
    super(
      `Corrupt projection checkpoint for arena ${arenaId} on network ${network}: ${reason}`,
    );
    this.name = "CorruptCheckpointError";
  }
}

/** Raised when a lease claim fails because another process holds it. */
export class LeaseHeldError extends Error {
  constructor(
    readonly arenaId: string,
    readonly network: string,
    readonly heldBy: string,
  ) {
    super(
      `Projection replay lease for arena ${arenaId} on network ${network} is held by ${heldBy}`,
    );
    this.name = "LeaseHeldError";
  }
}

/** Detects a Prisma unique-constraint violation (P2002) without importing the runtime error class. */
function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Sentinel `lastLedgerSequence` value used only for a row `claimLease`
 * creates as a lease placeholder before any batch has actually committed.
 * Ledger sequences are always >= 1 on a real chain, so -1 can never collide
 * with a genuine checkpoint written by `save()`.
 */
const NEVER_CHECKPOINTED_SENTINEL = -1;

/** Minimal structural check — enough to catch truncated/malformed JSON without over-validating every field. */
function isPlausibleProjectionState(value: unknown): value is ArenaProjectionState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.arenaId === "string" &&
    Array.isArray(v.players) &&
    Array.isArray(v.eliminated) &&
    Array.isArray(v.appliedEventIds) &&
    Array.isArray(v.skippedEventIds) &&
    typeof v.totalYieldStroops === "string"
  );
}

export class ArenaProjectionCheckpointStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Load the current checkpoint for `(arenaId, network)`, or null if replay
   * has never checkpointed this arena on this network (i.e. next replay
   * starts from genesis).
   *
   * A row can exist purely because `claimLease` created a placeholder for a
   * first-ever replay (lease claimed, but no batch has committed yet) —
   * that is NOT a real checkpoint and must still read as "no checkpoint",
   * otherwise a caller that races a lease claim against a genesis-ledger
   * check would wrongly think replay has already started from ledger 0.
   * Distinguished via `NEVER_CHECKPOINTED_SENTINEL`.
   *
   * @throws CorruptCheckpointError if a row exists, was actually
   *   checkpointed, but its JSON doesn't match the expected shape.
   */
  async load(
    arenaId: string,
    network: string,
  ): Promise<ArenaProjectionCheckpointRecord | null> {
    const row = await this.prisma.arenaProjectionCheckpoint.findUnique({
      where: { arenaId_network: { arenaId, network } },
    });
    if (!row) return null;
    if (row.lastLedgerSequence === NEVER_CHECKPOINTED_SENTINEL) return null;

    if (!isPlausibleProjectionState(row.projectionState)) {
      throw new CorruptCheckpointError(
        arenaId,
        network,
        "projectionState JSON does not match the expected ArenaProjectionState shape",
      );
    }

    return {
      arenaId: row.arenaId,
      network: row.network,
      lastLedgerSequence: row.lastLedgerSequence,
      projectionState: row.projectionState as unknown as ArenaProjectionState,
      status: row.status as ArenaProjectionCheckpointStatus,
      lastError: row.lastError,
      leaseOwner: row.leaseOwner,
      leaseExpiresAt: row.leaseExpiresAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Persist a new checkpoint after a batch has been folded. Upserts so the
   * first checkpoint for an arena creates its row. This is the ONLY write
   * path that should be used to advance `lastLedgerSequence` — callers must
   * only invoke this after the corresponding projection state has been
   * fully folded in memory (never before), so a crash between fold and
   * write leaves the checkpoint at the last known-good position.
   */
  async save(
    arenaId: string,
    network: string,
    state: ArenaProjectionState,
    status: ArenaProjectionCheckpointStatus,
    lastError: string | null = null,
  ): Promise<void> {
    const lastLedgerSequence = state.lastLedgerSequence ?? 0;
    const projectionState = state as unknown as Prisma.InputJsonValue;

    await this.prisma.arenaProjectionCheckpoint.upsert({
      where: { arenaId_network: { arenaId, network } },
      create: {
        arenaId,
        network,
        lastLedgerSequence,
        projectionState,
        status,
        lastError,
      },
      update: {
        lastLedgerSequence,
        projectionState,
        status,
        lastError,
      },
    });
  }

  /**
   * Mark a checkpoint `failed` with a reason, without advancing
   * `lastLedgerSequence`/`projectionState` (the last good position is
   * preserved so the next replay resumes correctly).
   */
  async markFailed(arenaId: string, network: string, lastError: string): Promise<void> {
    await this.prisma.arenaProjectionCheckpoint.updateMany({
      where: { arenaId, network },
      data: { status: "failed", lastError },
    });
  }

  /**
   * Atomically claim the replay lease for `(arenaId, network)`. Succeeds if
   * no row exists yet (first-ever replay creates it under this lease), or
   * if the existing lease is unheld/expired. Returns the lease token to
   * pass to `renewLease`/`releaseLease`.
   *
   * @throws LeaseHeldError if another process currently holds an active lease.
   */
  async claimLease(
    arenaId: string,
    network: string,
    leaseMs: number,
    leaseOwner: string = randomUUID(),
  ): Promise<string> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseMs);

    const claimed = await this.prisma.arenaProjectionCheckpoint.updateMany({
      where: {
        arenaId,
        network,
        OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: { leaseOwner, leaseExpiresAt: expiresAt, status: "replaying" },
    });

    if (claimed.count > 0) return leaseOwner;

    // No rows updated: either the row doesn't exist yet (first-ever replay
    // for this arena/network — create it under this lease), or it exists
    // with an active lease held by someone else.
    const existing = await this.prisma.arenaProjectionCheckpoint.findUnique({
      where: { arenaId_network: { arenaId, network } },
    });

    if (!existing) {
      try {
        await this.prisma.arenaProjectionCheckpoint.create({
          data: {
            arenaId,
            network,
            // Sentinel — this row exists only to hold the lease; no batch
            // has committed yet, so `load()` must still treat this as "no
            // checkpoint" (see NEVER_CHECKPOINTED_SENTINEL).
            lastLedgerSequence: NEVER_CHECKPOINTED_SENTINEL,
            projectionState: initialArenaProjection(arenaId) as unknown as Prisma.InputJsonValue,
            status: "replaying",
            leaseOwner,
            leaseExpiresAt: expiresAt,
          },
        });
        return leaseOwner;
      } catch (error) {
        // Unique constraint race: another process created the row between
        // our findUnique and this create. Fall through to re-check who
        // holds it, same as the "existing" branch below.
        if (!isUniqueConstraintError(error)) throw error;
      }
    }

    const holder =
      existing ??
      (await this.prisma.arenaProjectionCheckpoint.findUnique({
        where: { arenaId_network: { arenaId, network } },
      }));
    throw new LeaseHeldError(arenaId, network, holder?.leaseOwner ?? "unknown");
  }

  /** Extend an already-held lease (called after each batch commits). */
  async renewLease(
    arenaId: string,
    network: string,
    leaseOwner: string,
    leaseMs: number,
  ): Promise<void> {
    await this.prisma.arenaProjectionCheckpoint.updateMany({
      where: { arenaId, network, leaseOwner },
      data: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
    });
  }

  /** Release the lease (called when a replay pass finishes, successfully or not). */
  async releaseLease(arenaId: string, network: string, leaseOwner: string): Promise<void> {
    await this.prisma.arenaProjectionCheckpoint.updateMany({
      where: { arenaId, network, leaseOwner },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
  }
}
