/**
 * Player Dispute Evidence Package Service (#1517)
 *
 * Assembles a read-only, privacy-scoped evidence package for one arena/round
 * that a player can hand to support when they believe a commit, reveal,
 * elimination, refund, or payout outcome is inconsistent. See
 * `docs/DISPUTE_EVIDENCE_PACKAGE_DESIGN.md` for the full design note.
 *
 * Ownership: this service *composes* evidence from services that already own
 * each underlying fact — it derives nothing new about game outcomes itself:
 *  - `RoundProofBundleService` owns the verifiable elimination/tally proof.
 *  - `RoundService.getCommitStatus` (injected as a `CommitStatusReader`, see
 *    below) owns the player's own commit/reveal state.
 *  - `CancellationRecoveryService.getArenaRecovery` (injected as a
 *    `RefundStatusReader`, see below) owns refund status for cancelled arenas.
 *  - `contractCapability`/`ledgerClock`/`ledgerContinuity` own on-chain
 *    version, freshness and rollback-recovery state.
 * This keeps the evidence package a read/derive path with no new on-chain
 * calls of its own and no writes, mirroring `RoundProofBundleService`.
 */

import type { PrismaClient } from '@prisma/client';
import { RoundRepository } from '../repositories/roundRepository';
import type { RoundData, CommitReceipt } from '../types/round';
import {
  RoundProofBundleService,
  RoundNotResolvedError,
  RoundProofBundleUnavailableError,
} from './roundProofBundleService';
import { negotiateCapability } from './contractCapability';
import { getCurrentLedgerSequence } from './ledgerClock';
import { getRollbackGuard } from './ledgerContinuity';
import { getStellarConfig, type StellarConfig } from '../config/stellarConfig';
import { Money } from '../types/money';
import { contextLogger, maskWalletAddress } from '../utils/logger';
import { computeEvidenceChecksum } from '../utils/evidenceChecksum';
import {
  EVIDENCE_PACKAGE_SCHEMA_VERSION,
  type DisputeEvidencePackage,
  type EvidenceDecisionRecord,
  type EvidenceUnavailableEntry,
} from '../types/evidence';
import {
  evidencePackageGenerationTotal,
  evidencePackageGenerationDuration,
} from '../utils/metrics';

/** The requesting arena does not exist. */
export class EvidenceArenaNotFoundError extends Error {
  constructor(readonly arenaId: string) {
    super(`Arena ${arenaId} not found`);
    this.name = 'EvidenceArenaNotFoundError';
  }
}

/** The requested round does not exist for this arena. */
export class EvidenceRoundNotFoundError extends Error {
  constructor(readonly arenaId: string, readonly roundNumber: number) {
    super(`Round ${roundNumber} not found for arena ${arenaId}`);
    this.name = 'EvidenceRoundNotFoundError';
  }
}

/**
 * The requesting wallet has no record in this round at all (never committed,
 * never eliminated, no on-chain-active membership, no payout, no refund
 * entry). Evidence generation is bounded to rounds a wallet actually
 * participated in — this is the guard against cross-wallet enumeration.
 */
export class EvidenceNotParticipantError extends Error {
  constructor(readonly arenaId: string, readonly roundNumber: number) {
    super(`Requesting wallet has no recorded participation in round ${roundNumber} of arena ${arenaId}`);
    this.name = 'EvidenceNotParticipantError';
  }
}

export interface EvidenceRequestor {
  userId: string;
  walletAddress: string;
}

/**
 * The one `RoundService` capability this service needs. Depended on
 * structurally (accepted as a constructor param, no default/import of the
 * concrete `RoundService` class here) so this file — and its unit tests —
 * never pull in `RoundService`'s much larger dependency graph (Soroban RPC
 * client construction, `getStellarConfig()` at call sites, etc.) just to
 * read a commit receipt.
 */
export interface CommitStatusReader {
  getCommitStatus(arenaId: string, roundNumber: number, walletAddress: string): Promise<CommitReceipt>;
}

/**
 * The slice of `CancellationRecoveryService.getArenaRecovery`'s result this
 * service reads. Declared locally (rather than importing
 * `ArenaCancellationRecovery` from `cancellationRecoveryService.ts`) for the
 * same reason as `CommitStatusReader` above — the real class's return type
 * is a structural superset of this, so `new CancellationRecoveryService(prisma)`
 * satisfies it without this file ever needing to load that module's types.
 */
export interface RefundParticipant {
  userId: string;
  recoveryStatus: string;
  refundAmount: number;
  submittedAt?: string;
  confirmedAt?: string;
  failureReason?: string;
  txHash?: string;
}

export interface ArenaRefundRecovery {
  cancelledAt: string;
  participants: RefundParticipant[];
}

export interface RefundStatusReader {
  getArenaRecovery(arenaId: string): Promise<ArenaRefundRecovery | null>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class DisputeEvidenceService {
  private readonly roundRepo: RoundRepository;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly commitStatusReader: CommitStatusReader,
    private readonly refundStatusReader: RefundStatusReader,
    private readonly proofBundleService: RoundProofBundleService = new RoundProofBundleService(prisma),
    private readonly stellarConfig: StellarConfig = getStellarConfig(),
  ) {
    this.roundRepo = new RoundRepository(prisma);
  }

  async generatePackage(
    arenaId: string,
    roundNumber: number,
    requestor: EvidenceRequestor,
  ): Promise<DisputeEvidencePackage> {
    const start = Date.now();
    const log = contextLogger();

    try {
      const arena = await this.prisma.arena.findUnique({ where: { id: arenaId } });
      if (!arena) {
        throw new EvidenceArenaNotFoundError(arenaId);
      }

      const round = await this.roundRepo.findByArenaAndNumber(arenaId, roundNumber);
      if (!round) {
        throw new EvidenceRoundNotFoundError(arenaId, roundNumber);
      }

      const commitReceipt = await this.commitStatusReader.getCommitStatus(arenaId, roundNumber, requestor.walletAddress);

      const isParticipant = await this.isParticipant(round, requestor, commitReceipt.status);
      if (!isParticipant) {
        throw new EvidenceNotParticipantError(arenaId, roundNumber);
      }

      const decisionRecords: EvidenceDecisionRecord[] = [];
      const unavailable: EvidenceUnavailableEntry[] = [];

      decisionRecords.push({
        type: 'COMMIT_STATUS',
        source: 'commit-receipt',
        timestamp: commitReceipt.asOf,
        data: {
          status: commitReceipt.status,
          reason: commitReceipt.reason ?? null,
          choice: commitReceipt.choice ?? null,
        },
      });

      const { eliminated, survived, aggregate } =
        await this.deriveOutcomeProof(round, requestor.userId, decisionRecords, unavailable);

      this.derivePayoutRecord(round, requestor.userId, decisionRecords);
      await this.deriveRefundRecord(arenaId, requestor.userId, decisionRecords);

      const quarantined = getRollbackGuard().isQuarantined();
      decisionRecords.push({
        type: 'LEDGER_CONTINUITY',
        source: 'ledger-continuity',
        timestamp: nowIso(),
        data: { quarantined },
      });
      if (quarantined) {
        unavailable.push({
          field: 'onChainFreshness',
          reason: 'LEDGER_ROLLBACK_IN_PROGRESS',
          detail: 'A ledger rollback is being recovered from; on-chain-derived fields in this package are provisional.',
          sourceTimestamp: nowIso(),
        });
      }

      const arenaContractId = this.resolveArenaContractId(arena.metadata as Record<string, unknown> | null);
      const { arenaContractVersion, ledgerSequence } = await this.deriveConfigVersions(arenaContractId, unavailable);

      const packageWithoutChecksum: Omit<DisputeEvidencePackage, 'checksum'> = {
        schemaVersion: EVIDENCE_PACKAGE_SCHEMA_VERSION,
        identifiers: {
          arenaId,
          arenaContractId,
          roundId: round.id,
          roundNumber,
          networkPassphrase: this.stellarConfig.networkPassphrase,
        },
        configVersions: { arenaContractVersion, ledgerSequence },
        freshness: { generatedAt: nowIso(), degraded: quarantined },
        phase: {
          state: round.state,
          createdAt: round.createdAt.toISOString(),
          updatedAt: round.updatedAt.toISOString(),
        },
        player: {
          userId: requestor.userId,
          walletAddress: requestor.walletAddress,
          ...(eliminated !== undefined ? { eliminated } : {}),
          ...(survived !== undefined ? { survived } : {}),
          ...(commitReceipt.choice !== undefined ? { revealedChoice: commitReceipt.choice } : {}),
        },
        aggregate,
        decisionRecords,
        unavailable,
      };

      const checksum = computeEvidenceChecksum(packageWithoutChecksum);
      const result: DisputeEvidencePackage = { ...packageWithoutChecksum, checksum };

      const durationSeconds = (Date.now() - start) / 1000;
      evidencePackageGenerationDuration.observe(durationSeconds);
      evidencePackageGenerationTotal.inc({ status: 'success' });
      log.info(
        {
          arenaId,
          roundNumber,
          walletAddress: maskWalletAddress(requestor.walletAddress),
          durationSeconds,
          checksum: checksum.slice(0, 12),
        },
        'dispute evidence package generated',
      );

      return result;
    } catch (error) {
      const durationSeconds = (Date.now() - start) / 1000;
      evidencePackageGenerationDuration.observe(durationSeconds);
      const status =
        error instanceof EvidenceArenaNotFoundError
          ? 'arena_not_found'
          : error instanceof EvidenceRoundNotFoundError
            ? 'round_not_found'
            : error instanceof EvidenceNotParticipantError
              ? 'not_participant'
              : 'error';
      evidencePackageGenerationTotal.inc({ status });
      if (status === 'error') {
        log.error(
          {
            arenaId,
            roundNumber,
            walletAddress: maskWalletAddress(requestor.walletAddress),
            err: error instanceof Error ? error.message : String(error),
          },
          'dispute evidence package generation failed',
        );
      }
      throw error;
    }
  }

  /**
   * A wallet may pull evidence only for a round it actually has a footprint
   * in — this is what stands between this endpoint and an arbitrary
   * cross-wallet enumeration tool. Checked broadly: any of the independent
   * signals a real participant could have is sufficient, since a legitimate
   * non-revealer (AFK-eliminated) has none of playerChoices/eliminationLog
   * membership individually guaranteed except `allActivePlayerIds`.
   */
  private async isParticipant(
    round: RoundData,
    requestor: EvidenceRequestor,
    commitStatus: string,
  ): Promise<boolean> {
    if (commitStatus === 'accepted' || commitStatus === 'pending' || commitStatus === 'expired') return true;
    if (round.playerChoices.some((choice) => choice.userId === requestor.userId)) return true;
    if (round.allActivePlayerIds?.includes(requestor.userId)) return true;
    if (round.resolution?.payouts.some((payout) => payout.userId === requestor.userId)) return true;

    const eliminationLog = await this.prisma.eliminationLog.findFirst({
      where: { roundId: round.id, userId: requestor.userId },
    });
    return eliminationLog !== null;
  }

  private async deriveOutcomeProof(
    round: RoundData,
    userId: string,
    decisionRecords: EvidenceDecisionRecord[],
    unavailable: EvidenceUnavailableEntry[],
  ): Promise<{
    eliminated?: boolean;
    survived?: boolean;
    aggregate: DisputeEvidencePackage['aggregate'];
  }> {
    const emptyAggregate: DisputeEvidencePackage['aggregate'] = {
      totalActivePlayers: null,
      totalEliminated: null,
      totalSurvivors: null,
      headsCount: null,
      tailsCount: null,
    };

    try {
      const bundle = await this.proofBundleService.getProofBundle(round.id);
      const eliminated = bundle.eliminatedPlayers.includes(userId);
      const survived = bundle.survivors.includes(userId);

      decisionRecords.push({
        type: 'ELIMINATION',
        source: 'round-proof-bundle',
        timestamp: bundle.generatedAt,
        data: {
          eliminated,
          survived,
          proofBundleChecksum: bundle.checksum,
          tally: bundle.tally,
        },
      });

      return {
        eliminated,
        survived,
        aggregate: {
          totalActivePlayers: bundle.allActivePlayerIds.length,
          totalEliminated: bundle.eliminatedPlayers.length,
          totalSurvivors: bundle.survivors.length,
          headsCount: bundle.tally.heads,
          tailsCount: bundle.tally.tails,
        },
      };
    } catch (error) {
      if (error instanceof RoundNotResolvedError) {
        unavailable.push({
          field: 'eliminationProof',
          reason: 'ROUND_NOT_RESOLVED',
          detail: `Round is in state ${round.state}; no outcome to prove yet.`,
          sourceTimestamp: round.updatedAt.toISOString(),
        });
      } else if (error instanceof RoundProofBundleUnavailableError) {
        unavailable.push({
          field: 'eliminationProof',
          reason: 'LEGACY_ROUND_NO_INDEX_DATA',
          detail: 'This round predates the outcome proof bundle index; no verifiable elimination proof exists for it.',
          sourceTimestamp: round.updatedAt.toISOString(),
        });
      } else {
        unavailable.push({
          field: 'eliminationProof',
          reason: 'PROOF_BUNDLE_ASSEMBLY_FAILED',
          detail: 'The outcome proof bundle could not be assembled.',
          sourceTimestamp: nowIso(),
        });
      }
      return { aggregate: emptyAggregate };
    }
  }

  /** A legitimately absent payout (e.g. this player did not win) is not "unavailable" — it is simply omitted. */
  private derivePayoutRecord(round: RoundData, userId: string, decisionRecords: EvidenceDecisionRecord[]): void {
    const payout = round.resolution?.payouts.find((entry) => entry.userId === userId);
    if (!payout) return;

    decisionRecords.push({
      type: 'PAYOUT',
      source: 'round-resolution',
      timestamp: round.updatedAt.toISOString(),
      data: {
        amount: this.moneyToDisplay(payout.amount),
        principal: this.moneyToDisplay(payout.principal),
        yieldAmount: this.moneyToDisplay(payout.yieldAmount),
        platformFee: this.moneyToDisplay(payout.platformFee),
        dust: this.moneyToDisplay(payout.dust),
      },
    });
  }

  private async deriveRefundRecord(arenaId: string, userId: string, decisionRecords: EvidenceDecisionRecord[]): Promise<void> {
    const recovery = await this.refundStatusReader.getArenaRecovery(arenaId);
    if (!recovery) return;

    const participant = recovery.participants.find((entry) => entry.userId === userId);
    if (!participant) return;

    decisionRecords.push({
      type: 'REFUND',
      source: 'cancellation-recovery',
      timestamp: participant.confirmedAt ?? participant.submittedAt ?? recovery.cancelledAt,
      data: {
        recoveryStatus: participant.recoveryStatus,
        refundAmount: participant.refundAmount,
        txHash: participant.txHash ?? null,
        failureReason: participant.failureReason ?? null,
      },
    });
  }

  private async deriveConfigVersions(
    arenaContractId: string | null,
    unavailable: EvidenceUnavailableEntry[],
  ): Promise<{ arenaContractVersion: number | null; ledgerSequence: number | null }> {
    let arenaContractVersion: number | null = null;
    let ledgerSequence: number | null = null;

    if (arenaContractId) {
      try {
        arenaContractVersion = await negotiateCapability('arena', arenaContractId);
      } catch {
        unavailable.push({
          field: 'configVersions.arenaContractVersion',
          reason: 'CONTRACT_VERSION_UNAVAILABLE',
          detail: 'The arena contract version could not be negotiated on-chain.',
          sourceTimestamp: nowIso(),
        });
      }
    } else {
      unavailable.push({
        field: 'configVersions.arenaContractVersion',
        reason: 'CONTRACT_VERSION_UNAVAILABLE',
        detail: 'Arena has no on-chain contractAddress recorded.',
        sourceTimestamp: nowIso(),
      });
    }

    try {
      ledgerSequence = await getCurrentLedgerSequence();
    } catch {
      unavailable.push({
        field: 'configVersions.ledgerSequence',
        reason: 'LEDGER_SEQUENCE_UNAVAILABLE',
        detail: 'The current Soroban ledger sequence could not be read.',
        sourceTimestamp: nowIso(),
      });
    }

    return { arenaContractVersion, ledgerSequence };
  }

  private resolveArenaContractId(metadata: Record<string, unknown> | null): string | null {
    const contractAddress = metadata?.contractAddress;
    return typeof contractAddress === 'string' && contractAddress.length > 0 ? contractAddress : null;
  }

  /** Reconstructs a `Money` instance from whatever shape survived the Postgres JSON round-trip
   * (a real class instance vs. a plain deserialized object are duck-type compatible here) so
   * formatting never depends on which one we were handed. */
  private moneyToDisplay(money: Money): string {
    return new Money(money.atomicAmount, money.asset.code, money.asset.issuer).toDisplayString();
  }
}
