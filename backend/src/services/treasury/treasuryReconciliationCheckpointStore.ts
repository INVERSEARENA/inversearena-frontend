/**
 * Checkpoint persistence for treasury reconciliation ingestion (#1511).
 *
 * Backed by the `TreasuryReconciliationCheckpoint` Prisma model. One row per
 * `(arenaId, network)`, mirroring `arenaProjectionCheckpointStore.ts`'s
 * (#1382) lease/advisory-lock pattern exactly, but scoped to this ingestion
 * job specifically — a distinct job from the #1382 arena state projection,
 * with its own checkpoint row and no shared state. Unlike that store, there
 * is no folded JSON state to persist here: reconciliation ingestion writes
 * its results directly as `TreasuryFeeRecord` rows (idempotent via their own
 * unique constraint), so the checkpoint only needs to track how far the
 * event stream has been scanned.
 */

import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";

export type TreasuryCheckpointStatus = "idle" | "ingesting" | "caught_up" | "failed";

export interface TreasuryCheckpointRecord {
  arenaId: string;
  network: string;
  lastLedgerSequence: number;
  lastKnownFeeBps: number;
  status: TreasuryCheckpointStatus;
  lastError: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  updatedAt: Date;
}

/** Matches `load_platform_fee_bps`'s own default in `contract/arena/src/storage.rs`. */
export const DEFAULT_PLATFORM_FEE_BPS = 1000;

/** Raised when a lease claim fails because another process holds it. */
export class TreasuryLeaseHeldError extends Error {
  constructor(readonly arenaId: string, readonly network: string, readonly heldBy: string) {
    super(`Treasury reconciliation lease for arena ${arenaId} on network ${network} is held by ${heldBy}`);
    this.name = "TreasuryLeaseHeldError";
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/** Sentinel for a lease-only placeholder row that has never actually checkpointed a batch. */
const NEVER_CHECKPOINTED_SENTINEL = -1;

export class TreasuryReconciliationCheckpointStore {
  constructor(private readonly prisma: PrismaClient) {}

  async load(arenaId: string, network: string): Promise<TreasuryCheckpointRecord | null> {
    const row = await this.prisma.treasuryReconciliationCheckpoint.findUnique({
      where: { arenaId_network: { arenaId, network } },
    });
    if (!row) return null;
    if (row.lastLedgerSequence === NEVER_CHECKPOINTED_SENTINEL) return null;

    return {
      arenaId: row.arenaId,
      network: row.network,
      lastLedgerSequence: row.lastLedgerSequence,
      lastKnownFeeBps: row.lastKnownFeeBps,
      status: row.status as TreasuryCheckpointStatus,
      lastError: row.lastError,
      leaseOwner: row.leaseOwner,
      leaseExpiresAt: row.leaseExpiresAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Persist progress after a batch of events has been fully ingested (records upserted). */
  async save(
    arenaId: string,
    network: string,
    lastLedgerSequence: number,
    lastKnownFeeBps: number,
    status: TreasuryCheckpointStatus,
    lastError: string | null = null,
  ): Promise<void> {
    await this.prisma.treasuryReconciliationCheckpoint.upsert({
      where: { arenaId_network: { arenaId, network } },
      create: { arenaId, network, lastLedgerSequence, lastKnownFeeBps, status, lastError },
      update: { lastLedgerSequence, lastKnownFeeBps, status, lastError },
    });
  }

  async markFailed(arenaId: string, network: string, lastError: string): Promise<void> {
    await this.prisma.treasuryReconciliationCheckpoint.updateMany({
      where: { arenaId, network },
      data: { status: "failed", lastError },
    });
  }

  /**
   * Atomically claim the ingestion lease for `(arenaId, network)` — same
   * conditional-`updateMany`-then-create-if-absent pattern as
   * `ArenaProjectionCheckpointStore.claimLease` (#1382), guarding against
   * two reconciliation runs racing for the same arena.
   */
  async claimLease(
    arenaId: string,
    network: string,
    leaseMs: number,
    leaseOwner: string = randomUUID(),
  ): Promise<string> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseMs);

    const claimed = await this.prisma.treasuryReconciliationCheckpoint.updateMany({
      where: {
        arenaId,
        network,
        OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: { leaseOwner, leaseExpiresAt: expiresAt, status: "ingesting" },
    });

    if (claimed.count > 0) return leaseOwner;

    const existing = await this.prisma.treasuryReconciliationCheckpoint.findUnique({
      where: { arenaId_network: { arenaId, network } },
    });

    if (!existing) {
      try {
        await this.prisma.treasuryReconciliationCheckpoint.create({
          data: {
            arenaId,
            network,
            lastLedgerSequence: NEVER_CHECKPOINTED_SENTINEL,
            status: "ingesting",
            leaseOwner,
            leaseExpiresAt: expiresAt,
          },
        });
        return leaseOwner;
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
      }
    }

    const holder =
      existing ??
      (await this.prisma.treasuryReconciliationCheckpoint.findUnique({
        where: { arenaId_network: { arenaId, network } },
      }));
    throw new TreasuryLeaseHeldError(arenaId, network, holder?.leaseOwner ?? "unknown");
  }

  async renewLease(arenaId: string, network: string, leaseOwner: string, leaseMs: number): Promise<void> {
    await this.prisma.treasuryReconciliationCheckpoint.updateMany({
      where: { arenaId, network, leaseOwner },
      data: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
    });
  }

  async releaseLease(arenaId: string, network: string, leaseOwner: string): Promise<void> {
    await this.prisma.treasuryReconciliationCheckpoint.updateMany({
      where: { arenaId, network, leaseOwner },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
  }
}
