/**
 * Round Outcome Proof Bundle Service (#1394)
 *
 * Assembles a self-contained, structurally verifiable record of how a
 * resolved round's survivor set was derived, so a client does not have to
 * blindly trust the backend's own `resolution.eliminatedPlayers` /
 * `resolution.survivors` verdict. See `docs/round-outcome-proof-bundle.md`
 * for the full design note (ownership, state transitions, failure behavior,
 * compatibility).
 *
 * Ownership: this service *owns* bundle assembly. It reads already-resolved
 * round data (the `RoundRepository`, which is itself sourced from on-chain
 * reads performed by `RoundService.resolveRound` — see #1098) and is a pure
 * read/derive path with no additional on-chain calls and no writes. It does
 * not verify anything itself; verification is the client's job (see
 * `frontend/src/shared-d/utils/contract-state-parsers.ts`'s
 * `recomputeSurvivorship`).
 */

import { createHash } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { RoundRepository } from '../repositories/roundRepository';
import { RoundState } from '../types/round';
import type {
  ProofBundlePlayerChoice,
  ProofBundleTally,
  RoundProofBundle,
} from '../types/round';
import { ROUND_PROOF_BUNDLE_VERSION } from '../types/round';
import { getStellarConfig, type StellarConfig } from '../config/stellarConfig';
import { contextLogger } from '../utils/logger';
import {
  proofBundleAssemblyDuration,
  proofBundleAssemblyRetriesTotal,
  proofBundleAssemblyTotal,
} from '../utils/metrics';

/** Raised when a round exists but has not been resolved yet — there is nothing to prove. */
export class RoundNotResolvedError extends Error {
  constructor(readonly roundId: string, readonly state: string) {
    super(`Round ${roundId} is not resolved yet (state: ${state}); no proof bundle exists.`);
    this.name = 'RoundNotResolvedError';
  }
}

/** Raised when a round's stored resolution metadata is missing or malformed. */
export class RoundProofBundleAssemblyError extends Error {
  constructor(readonly roundId: string, reason: string) {
    super(`Failed to assemble proof bundle for round ${roundId}: ${reason}`);
    this.name = 'RoundProofBundleAssemblyError';
  }
}

/**
 * Raised when a round was resolved before `allActivePlayerIds` started being
 * persisted in resolution metadata (#1394 predates this field). Without it,
 * non-revealers cannot be distinguished from "never existed", so any bundle
 * we produced would silently omit AFK eliminations instead of representing
 * them — a correctness gap, not a formatting one. We refuse to synthesize a
 * degraded bundle; see the design note's "compatibility constraints" section
 * for the accepted operational impact (pre-migration rounds have no bundle).
 */
export class RoundProofBundleUnavailableError extends Error {
  constructor(readonly roundId: string) {
    super(
      `Round ${roundId} was resolved before proof bundles were introduced ` +
        '(no allActivePlayerIds recorded); no bundle can be assembled for it.',
    );
    this.name = 'RoundProofBundleUnavailableError';
  }
}

export interface RoundProofBundleOptions {
  /** Number of attempts on top of the first try when a read looks transiently inconsistent. Default 2. */
  maxRetries?: number;
  /** Base delay between retries in ms (linear backoff). Default 50. */
  retryDelayMs?: number;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 50;

/**
 * Canonical, deterministic JSON stringify: object keys sorted recursively so
 * the same logical bundle always hashes to the same checksum regardless of
 * property insertion order. Arrays keep their (already-sorted-by-caller)
 * order since element order is semantically meaningful here (e.g.
 * `playerChoices` sorted by `userId`).
 */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalStringify((value as Record<string, unknown>)[key])}`,
  );
  return `{${entries.join(',')}}`;
}

function computeChecksum(bundleWithoutChecksum: Omit<RoundProofBundle, 'checksum'>): string {
  return createHash('sha256').update(canonicalStringify(bundleWithoutChecksum)).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RoundProofBundleService {
  private roundRepo: RoundRepository;

  constructor(
    private prisma: PrismaClient,
    private stellarConfig: StellarConfig = getStellarConfig(),
  ) {
    this.roundRepo = new RoundRepository(prisma);
  }

  /**
   * Build the proof bundle for a resolved round.
   *
   * Idempotent and safe to call repeatedly for the same `roundId` (duplicate
   * delivery / retries / concurrent requests all read the same immutable,
   * already-persisted resolution and produce byte-identical output — see
   * the design note's "duplicate delivery" and "concurrent requests" edge
   * cases). Does not mutate any state.
   *
   * @throws RoundNotResolvedError if the round has not reached RESOLVED/SETTLED.
   * @throws RoundProofBundleUnavailableError if the round predates `allActivePlayerIds`
   *   being recorded at resolution time — not transient, never retried.
   * @throws RoundProofBundleAssemblyError if resolution metadata is missing or malformed
   *   after retries are exhausted (partial-failure / restart-during-work recovery).
   */
  async getProofBundle(
    roundId: string,
    options: RoundProofBundleOptions = {},
  ): Promise<RoundProofBundle> {
    const { maxRetries = DEFAULT_MAX_RETRIES, retryDelayMs = DEFAULT_RETRY_DELAY_MS } = options;
    const log = contextLogger();
    const start = Date.now();

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const bundle = await this.assembleOnce(roundId);
        const durationSeconds = (Date.now() - start) / 1000;
        proofBundleAssemblyDuration.observe(durationSeconds);
        proofBundleAssemblyTotal.inc({ status: 'success' });
        log.info(
          { roundId, attempt, durationSeconds },
          'round proof bundle assembled',
        );
        return bundle;
      } catch (error) {
        lastError = error;
        // RoundNotResolvedError and RoundProofBundleUnavailableError are not
        // transient — retrying will never help, they mean "there is nothing
        // to prove (yet / ever)" (#1394 failure-behavior: do not retry a
        // semantically-final answer).
        if (error instanceof RoundNotResolvedError) {
          proofBundleAssemblyTotal.inc({ status: 'not_resolved' });
          throw error;
        }
        if (error instanceof RoundProofBundleUnavailableError) {
          proofBundleAssemblyTotal.inc({ status: 'unavailable' });
          throw error;
        }
        const isLastAttempt = attempt === maxRetries;
        log.warn(
          { roundId, attempt, isLastAttempt, err: error instanceof Error ? error.message : String(error) },
          'round proof bundle assembly attempt failed',
        );
        if (isLastAttempt) break;
        proofBundleAssemblyRetriesTotal.inc();
        await sleep(retryDelayMs * (attempt + 1));
      }
    }

    const durationSeconds = (Date.now() - start) / 1000;
    proofBundleAssemblyDuration.observe(durationSeconds);
    proofBundleAssemblyTotal.inc({ status: 'error' });
    log.error(
      { roundId, err: lastError instanceof Error ? lastError.message : String(lastError) },
      'round proof bundle assembly failed after retries exhausted',
    );

    if (lastError instanceof Error) throw lastError;
    throw new RoundProofBundleAssemblyError(roundId, String(lastError));
  }

  private async assembleOnce(roundId: string): Promise<RoundProofBundle> {
    const round = await this.roundRepo.findById(roundId);
    if (!round) {
      // Not found is a distinct case from "not resolved" — surfaced as a
      // plain Error so the controller can map it to 404 the same way
      // RoundService.resolveRound's "Round not found" is mapped today.
      throw new Error(`Round ${roundId} not found`);
    }

    if (round.state !== RoundState.RESOLVED && round.state !== RoundState.SETTLED) {
      throw new RoundNotResolvedError(roundId, round.state);
    }

    const resolution = round.resolution;
    if (!resolution) {
      // Partial-failure / restart-during-work: the round was marked
      // RESOLVED (state transition committed) but resolution metadata is
      // absent or was truncated. This should be unreachable given
      // `RoundRepository.resolveAtomically`'s single transaction, but if it
      // ever happens the caller must not synthesize a fake bundle — that
      // would let a corrupted read masquerade as a verifiable proof.
      throw new RoundProofBundleAssemblyError(roundId, 'resolved round has no resolution metadata');
    }

    // The full active-player set as it stood at resolution time (revealers +
    // non-revealers), persisted by RoundService.resolveRound. This is
    // deliberately NOT re-derived from `playerChoices` — that only contains
    // revealers, and the contract's `resolve_players` eliminates
    // non-revealers unconditionally (AFK elimination; see
    // `contract/arena/src/lib.rs`), so `resolution.eliminatedPlayers` can
    // legitimately contain ids that never appear in `playerChoices`. Deriving
    // `allActivePlayerIds` from `playerChoices` would silently drop those
    // non-revealers from the bundle while still claiming them as eliminated,
    // producing a bundle a client cannot correctly verify against.
    if (!round.allActivePlayerIds || round.allActivePlayerIds.length === 0) {
      throw new RoundProofBundleUnavailableError(roundId);
    }
    const allActivePlayerIds = [...new Set(round.allActivePlayerIds)].sort();
    const activePlayerSet = new Set(allActivePlayerIds);

    // Revealed choices only — non-revealers are intentionally omitted (see
    // ProofBundlePlayerChoice doc comment) but remain present in
    // `allActivePlayerIds` and (if eliminated) in `eliminatedPlayers`, so the
    // client can still account for them. A maximum-size input (#1394 edge
    // case) is already bounded upstream by RoundInputSchema's `.max(500)` on
    // playerChoices, so this mirrors that same natural cap rather than
    // introducing a second limit to keep in sync.
    const playerChoices: ProofBundlePlayerChoice[] = [...round.playerChoices]
      .filter(
        (entry): entry is ProofBundlePlayerChoice & { stake: number } =>
          (entry.choice === 'heads' || entry.choice === 'tails') && activePlayerSet.has(entry.userId),
      )
      .map((entry) => ({ userId: entry.userId, choice: entry.choice as 'heads' | 'tails' }))
      .sort((a, b) => a.userId.localeCompare(b.userId));

    const tally: ProofBundleTally = playerChoices.reduce(
      (acc, entry) => {
        if (entry.choice === 'heads') acc.heads += 1;
        else acc.tails += 1;
        return acc;
      },
      { heads: 0, tails: 0 },
    );

    const arenaContractId = await this.resolveArenaContractId(round.arenaId);

    const bundleWithoutChecksum: Omit<RoundProofBundle, 'checksum'> = {
      version: ROUND_PROOF_BUNDLE_VERSION,
      roundId: round.id,
      arenaId: round.arenaId,
      roundNumber: round.roundNumber,
      network: {
        passphrase: this.stellarConfig.networkPassphrase,
        arenaContractId,
      },
      playerChoices,
      allActivePlayerIds,
      tally,
      eliminatedPlayers: [...new Set(resolution.eliminatedPlayers)].sort(),
      survivors: allActivePlayerIds.filter((userId) => !resolution.eliminatedPlayers.includes(userId)).sort(),
      generatedAt: new Date().toISOString(),
    };

    return {
      ...bundleWithoutChecksum,
      checksum: computeChecksum(bundleWithoutChecksum),
    };
  }

  /**
   * Reads the arena's on-chain contract id from its stored metadata.
   *
   * Uses the same `metadata.contractAddress` shape `arenas.ts`'s
   * `/sync-players` route already reads (see backend/src/routes/arenas.ts).
   * Missing metadata is surfaced as an assembly error rather than a silent
   * empty string, since a bundle with no `arenaContractId` cannot be
   * network-matched by a client (see the design note's "network mismatch"
   * failure behavior).
   */
  private async resolveArenaContractId(arenaId: string): Promise<string> {
    const arena = await this.prisma.arena.findUnique({ where: { id: arenaId } });
    const metadata = (arena?.metadata as Record<string, unknown> | null) ?? {};
    const contractAddress = metadata.contractAddress;
    if (typeof contractAddress !== 'string' || contractAddress.length === 0) {
      throw new RoundProofBundleAssemblyError(
        arenaId,
        'arena has no on-chain contractAddress recorded in metadata',
      );
    }
    return contractAddress;
  }
}
