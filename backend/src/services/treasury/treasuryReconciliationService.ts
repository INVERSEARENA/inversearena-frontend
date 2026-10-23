/**
 * Treasury fee reconciliation ingestion (#1511).
 *
 * For a single arena, scans its on-chain `claimed`/`fee_upd` event history
 * (via `treasuryEventReader.ts` — NOT the mismatched #1382 decoder, see that
 * module's doc comment) and derives one `TreasuryFeeRecord` per `claimed`
 * event: the platform fee the protocol's own configuration implies for that
 * claim, reconciled against whatever actual on-chain transfer (today: none
 * — see `backend/docs/TREASURY_RECONCILIATION_DESIGN.md` §1) can be found.
 *
 * Read-only over on-chain state: this service never submits a transaction
 * and never moves funds — see the issue's explicit "out of scope" note.
 *
 * Ownership: this is the *only* place that folds treasury events into
 * `TreasuryFeeRecord` rows, mirroring the #1382 projection's single-fold
 * ownership rule (`docs/projection-checkpoint-replay.md`). Ingestion
 * idempotency comes from two independent layers: the checkpoint (bounds
 * which ledger range is scanned) and the `TreasuryFeeRecord` unique
 * constraint on `(network, sourceTxHash, sourceEventId)` (makes re-scanning
 * the same event, e.g. after a crash mid-batch, a safe upsert rather than a
 * duplicate row).
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  TreasuryReconciliationCheckpointStore,
  TreasuryLeaseHeldError,
  DEFAULT_PLATFORM_FEE_BPS,
  type TreasuryCheckpointRecord,
} from "./treasuryReconciliationCheckpointStore";
import {
  computeExpectedPlatformFee,
  classifyReconciliation,
  isLedgerFinalized,
  type ReconciliationStatus,
  type DiscrepancyType,
} from "../../domain/treasuryFeeMath";
import type { TreasuryConfig } from "../../config/treasuryConfig";
import { getTreasuryConfig } from "../../config/treasuryConfig";
import { getRollbackGuard } from "../ledgerContinuity";
import { contextLogger } from "../../utils/logger";
import {
  treasuryIngestionRunsTotal,
  treasuryIngestionDurationSeconds,
  treasuryLeaseConflictsTotal,
  treasuryRecordsByStatusTotal,
  treasuryDiscrepanciesTotal,
} from "./treasuryMetrics";

/**
 * Local structural mirror of `treasuryEventReader.ts`'s `ClaimedTreasuryEvent`
 * / `FeeUpdatedTreasuryEvent` / `TreasuryEventPage`. Declared here rather
 * than imported so this file — and its unit tests — never pull in that
 * module's `StellarRpcGateway` import, which crosses the frontend/backend
 * package boundary and fails `tsc`'s `rootDir` check (a pre-existing,
 * unrelated condition; see that file's own doc comment). The real reader
 * satisfies this structurally at the composition root (wherever
 * `TreasuryReconciliationService` is actually constructed for production
 * use) without either file needing to import the other's types.
 */
interface ClaimedEventLike {
  topic: "claimed";
  id: string;
  ledgerSequence: number;
  ledgerClosedAt: string;
  txHash: string;
  winner: string;
  amountAtomic: bigint;
  yieldAmountAtomic: bigint;
}

interface FeeUpdatedEventLike {
  topic: "fee_upd";
  id: string;
  ledgerSequence: number;
  ledgerClosedAt: string;
  txHash: string;
  admin: string;
  feeBps: number;
}

interface UnknownEventLike {
  topic: "unknown";
  id: string;
  ledgerSequence: number;
  ledgerClosedAt: string;
  txHash: string;
}

type TreasuryEventLike = ClaimedEventLike | FeeUpdatedEventLike | UnknownEventLike;

interface TreasuryEventPageLike {
  events: TreasuryEventLike[];
  latestLedger: number;
  cursor: string | null;
}

/** Injectable event-page source — decouples this service from any one RPC transport for testing. */
export interface TreasuryEventSource {
  getTreasuryEvents(
    contractId: string,
    options: { startLedger: number; cursor?: undefined } | { cursor: string; startLedger?: undefined },
    limit?: number,
  ): Promise<TreasuryEventPageLike>;
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_BATCH_SIZE = 1000;
const GENESIS_LEDGER = 1;

export interface ReconcileArenaResult {
  arenaId: string;
  network: string;
  eventsProcessed: number;
  recordsWritten: number;
  lastLedgerSequence: number;
}

export class TreasuryReconciliationService {
  private readonly checkpoints: TreasuryReconciliationCheckpointStore;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly eventSource: TreasuryEventSource,
    private readonly config: TreasuryConfig = getTreasuryConfig(),
    private readonly leaseMs: number = DEFAULT_LEASE_MS,
    private readonly batchSize: number = DEFAULT_BATCH_SIZE,
  ) {
    this.checkpoints = new TreasuryReconciliationCheckpointStore(prisma);
  }

  /**
   * Ingest new events for one arena, from its last checkpoint through the
   * chain tip, writing/updating `TreasuryFeeRecord` rows along the way.
   *
   * @throws TreasuryLeaseHeldError if another process is already
   *   reconciling this arena/network.
   */
  /**
   * `asset` is the arena's own stake-token asset code (e.g. from
   * `Arena.metadata.stakeToken`, captured at arena creation by
   * `ArenaService.confirmArenaDeployment`) — the `claimed` event itself
   * carries only bare `i128` amounts, no asset/token identity, since that's
   * fixed per-arena on `ArenaConfig.stake_token` rather than repeated on
   * every event.
   */
  async reconcileArena(arenaId: string, contractId: string, network: string, asset: string): Promise<ReconcileArenaResult> {
    const start = Date.now();
    const log = contextLogger();
    let leaseOwner: string | null = null;

    try {
      leaseOwner = await this.checkpoints.claimLease(arenaId, network, this.leaseMs);
    } catch (error) {
      if (error instanceof TreasuryLeaseHeldError) {
        treasuryLeaseConflictsTotal.inc();
      }
      throw error;
    }

    try {
      const checkpoint = await this.checkpoints.load(arenaId, network);
      let currentFeeBps = checkpoint?.lastKnownFeeBps ?? DEFAULT_PLATFORM_FEE_BPS;
      let lastLedgerSequence = checkpoint?.lastLedgerSequence ?? GENESIS_LEDGER - 1;
      let eventsProcessed = 0;
      let recordsWritten = 0;

      let cursor: string | undefined;
      let startLedger: number | undefined = lastLedgerSequence + 1;

      for (;;) {
        const page: TreasuryEventPageLike = await this.eventSource.getTreasuryEvents(
          contractId,
          cursor ? { cursor } : { startLedger: startLedger as number },
          this.batchSize,
        );

        for (const event of page.events) {
          eventsProcessed++;
          if (event.topic === "fee_upd") {
            currentFeeBps = event.feeBps;
          } else if (event.topic === "claimed") {
            const wrote = await this.upsertFeeRecord(arenaId, network, asset, event, currentFeeBps);
            if (wrote) recordsWritten++;
          }
          // "unknown" topics (any other event this arena emits) are silently
          // skipped — this reader only decodes the two topics it needs (see
          // treasuryEventReader.ts); skipping is not a failure.
          if (event.ledgerSequence > lastLedgerSequence) {
            lastLedgerSequence = event.ledgerSequence;
          }
        }

        // Checkpoint after every batch commits, before fetching the next —
        // same durability ordering as the #1382 replay engine.
        await this.checkpoints.save(arenaId, network, lastLedgerSequence, currentFeeBps, "ingesting");
        await this.checkpoints.renewLease(arenaId, network, leaseOwner, this.leaseMs);

        if (!page.cursor) break;
        cursor = page.cursor;
        startLedger = undefined;
      }

      await this.checkpoints.save(arenaId, network, lastLedgerSequence, currentFeeBps, "caught_up");

      const durationSeconds = (Date.now() - start) / 1000;
      treasuryIngestionDurationSeconds.observe(durationSeconds);
      treasuryIngestionRunsTotal.inc({ result: "success" });
      log.info(
        { arenaId, network, eventsProcessed, recordsWritten, lastLedgerSequence, durationSeconds },
        "treasury reconciliation ingestion completed",
      );

      return { arenaId, network, eventsProcessed, recordsWritten, lastLedgerSequence };
    } catch (error) {
      const durationSeconds = (Date.now() - start) / 1000;
      treasuryIngestionDurationSeconds.observe(durationSeconds);
      treasuryIngestionRunsTotal.inc({ result: "error" });
      await this.checkpoints.markFailed(arenaId, network, error instanceof Error ? error.message : String(error));
      log.error(
        { arenaId, network, err: error instanceof Error ? error.message : String(error) },
        "treasury reconciliation ingestion failed",
      );
      throw error;
    } finally {
      if (leaseOwner) await this.checkpoints.releaseLease(arenaId, network, leaseOwner);
    }
  }

  /**
   * Derive and upsert the `TreasuryFeeRecord` for one `claimed` event.
   * Idempotent by construction: the unique constraint on
   * `(network, sourceTxHash, sourceEventId)` means re-processing the same
   * event (duplicate delivery, or a re-scanned batch after a crash) upserts
   * the same logical row rather than creating a duplicate — and re-running
   * classification on each pass lets a `pending` record naturally resolve
   * to `balanced`/`discrepant` once its ledger clears the finality window.
   */
  private async upsertFeeRecord(
    arenaId: string,
    network: string,
    asset: string,
    event: ClaimedEventLike,
    feeBpsApplied: number,
  ): Promise<boolean> {
    const expectedAmountAtomic = computeExpectedPlatformFee(event.yieldAmountAtomic, feeBpsApplied);
    const ledgerClosedAt = new Date(event.ledgerClosedAt);
    // A ledger rollback currently being recovered from (#1490) means recent
    // on-chain reads are provisional — treat this record as not-yet-final
    // even past the ordinary grace window, same principle as
    // `oracleFreshnessService.ts`'s reorg handling.
    const ledgerFinalized =
      !getRollbackGuard().isQuarantined() &&
      isLedgerFinalized(ledgerClosedAt, new Date(), this.config.finalityGraceSeconds);

    // No on-chain fee-collection transfer mechanism exists today (see design
    // note §1) — `claim()` transfers the full amount to the winner, never to
    // a treasury destination. There is therefore never an "actual transfer"
    // to find for the fee specifically; this always classifies honestly as
    // `missing_transfer` once a nonzero fee is expected and finalized.
    const { status, discrepancyType } = classifyReconciliation({
      expectedAmountAtomic,
      expectedDestination: this.config.treasuryDestination,
      actualTransfer: null,
      ledgerFinalized,
    });

    const data = {
      network,
      recordType: "platform_fee",
      arenaId,
      asset,
      assetIssuer: null,
      sourceTxHash: event.txHash,
      sourceEventId: event.id,
      sourceLedgerSequence: event.ledgerSequence,
      sourceLedgerClosedAt: ledgerClosedAt,
      expectedAmountAtomic,
      configVersion: this.config.version,
      feeBpsApplied,
      destination: this.config.treasuryDestination,
      status,
      discrepancyType,
      reconciledAt: status !== "pending" ? new Date() : null,
    } satisfies Prisma.TreasuryFeeRecordUncheckedCreateInput;

    await this.prisma.treasuryFeeRecord.upsert({
      where: { network_sourceTxHash_sourceEventId: { network, sourceTxHash: event.txHash, sourceEventId: event.id } },
      create: data,
      update: data,
    });

    treasuryRecordsByStatusTotal.inc({ status });
    if (discrepancyType) treasuryDiscrepanciesTotal.inc({ discrepancy_type: discrepancyType });

    return true;
  }
}

export type { ReconciliationStatus, DiscrepancyType, TreasuryCheckpointRecord };
