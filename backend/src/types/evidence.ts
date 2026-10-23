import { z } from 'zod';

/**
 * Player Dispute Evidence Package (#1517)
 *
 * See backend/docs/DISPUTE_EVIDENCE_PACKAGE_DESIGN.md for the full design
 * note. This module only holds the response shape and its schema version —
 * assembly lives in `services/disputeEvidenceService.ts`.
 */

/** Bump on any breaking shape change. A verifier refuses to trust a package
 * whose version it does not recognize rather than guessing at its shape. */
export const EVIDENCE_PACKAGE_SCHEMA_VERSION = 1 as const;

export const EvidenceParamsSchema = z.object({
  id: z.string().trim().min(1).max(200),
  roundNumber: z.coerce.number().int().min(1).max(1_000_000),
});

/**
 * Typed reasons a piece of evidence could not be produced. Every entry in
 * `unavailable` carries one of these plus the timestamp of the source read
 * that came up empty, so support can tell "nothing to show" apart from
 * "we couldn't check."
 */
export type EvidenceUnavailableReason =
  /** The round has not reached RESOLVED/SETTLED — there is no outcome to prove yet. */
  | 'ROUND_NOT_RESOLVED'
  /** The round predates `allActivePlayerIds` being recorded (#1394); no proof bundle can be assembled. */
  | 'LEGACY_ROUND_NO_INDEX_DATA'
  /** Proof bundle assembly failed after retries for a reason other than the two above. */
  | 'PROOF_BUNDLE_ASSEMBLY_FAILED'
  /** The arena's on-chain contract version could not be negotiated (RPC failure or unversioned deployment). */
  | 'CONTRACT_VERSION_UNAVAILABLE'
  /** The current ledger sequence could not be read (RPC failure). */
  | 'LEDGER_SEQUENCE_UNAVAILABLE'
  /** A ledger rollback is being recovered from; on-chain-derived freshness claims are not trustworthy right now. */
  | 'LEDGER_ROLLBACK_IN_PROGRESS';

export interface EvidenceUnavailableEntry {
  /** Dot-path-ish label of the field/section that could not be produced, e.g. "eliminationProof". */
  field: string;
  reason: EvidenceUnavailableReason;
  /** Non-sensitive, human-readable elaboration — never a raw error message or stack trace. */
  detail?: string;
  /** ISO-8601 timestamp of the source read that this gap was observed at. */
  sourceTimestamp: string;
}

export type EvidenceDecisionRecordType =
  | 'ELIMINATION'
  | 'PAYOUT'
  | 'REFUND'
  | 'COMMIT_STATUS'
  | 'LEDGER_CONTINUITY';

/** A single backend decision relevant to the requesting player's round outcome. Every
 * record is scoped to the requesting player alone — no other player's identity or
 * choice ever appears here (see the design note's "privacy scoping" section). */
export interface EvidenceDecisionRecord {
  type: EvidenceDecisionRecordType;
  /** Where this record was derived from, so support can trace it back to the owning service. */
  source: 'round-proof-bundle' | 'round-resolution' | 'commit-receipt' | 'cancellation-recovery' | 'ledger-continuity';
  timestamp: string;
  data: Record<string, unknown>;
}

export interface EvidencePlayerStatus {
  userId: string;
  walletAddress: string;
  /** Present only when the outcome proof bundle was available (see `unavailable`). */
  eliminated?: boolean;
  survived?: boolean;
  /** The player's own revealed choice, if any — never another player's. */
  revealedChoice?: 'heads' | 'tails';
}

export interface EvidenceCanonicalIdentifiers {
  arenaId: string;
  arenaContractId: string | null;
  roundId: string;
  roundNumber: number;
  networkPassphrase: string;
}

export interface EvidenceConfigVersions {
  /** Negotiated on-chain arena contract version (#1409), when it could be read. */
  arenaContractVersion: number | null;
  /** Soroban ledger sequence the on-chain reads in this package were taken at, when available. */
  ledgerSequence: number | null;
}

export interface EvidenceFreshness {
  /** Server timestamp this package was assembled at. */
  generatedAt: string;
  /** True while a ledger rollback is being recovered from (see ledgerContinuity.ts) — any
   * on-chain-derived claim in this package should be treated as provisional. */
  degraded: boolean;
}

export interface EvidenceAggregate {
  totalActivePlayers: number | null;
  totalEliminated: number | null;
  totalSurvivors: number | null;
  headsCount: number | null;
  tailsCount: number | null;
}

export interface DisputeEvidencePackage {
  schemaVersion: typeof EVIDENCE_PACKAGE_SCHEMA_VERSION;
  identifiers: EvidenceCanonicalIdentifiers;
  configVersions: EvidenceConfigVersions;
  freshness: EvidenceFreshness;
  phase: {
    state: string;
    createdAt: string;
    updatedAt: string;
  };
  player: EvidencePlayerStatus;
  /** Anonymized/aggregate view of the other players in this round — counts only, never ids or choices. */
  aggregate: EvidenceAggregate;
  decisionRecords: EvidenceDecisionRecord[];
  unavailable: EvidenceUnavailableEntry[];
  /** SHA-256 hex digest of this package's canonical JSON form, excluding this field itself. */
  checksum: string;
}
