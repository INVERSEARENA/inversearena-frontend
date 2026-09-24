import { PrismaClient } from '@prisma/client';
import { Contract, Keypair, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { StellarRpcGateway } from "../../frontend/src/shared-d/services/stellarRpcGateway";

import { RoundRepository } from '../repositories/roundRepository';
import type {
  RoundInput,
  RoundMetadata,
  RoundResolution,
  CommitReceipt,
} from '../types/round';
import { RoundState } from '../types/round';
import {
  arenaStateTransitionsTotal,
  playersEliminatedTotal,
  refreshArenaMetrics,
  roundResolutionsTotal,
  roundResolutionDuration,
  commitReceiptLookupsTotal,
  commitReceiptLookupDuration,
} from '../utils/metrics';
import { invalidateArenaStats } from '../cache/cacheService';
import {
  getOnChainActivePlayerIds,
  getOnChainWinner,
} from './onChainReader';
import { getStellarConfig, type StellarConfig } from '../config/stellarConfig';
import { buildRoundResolution } from '../domain/roundResolution';
import { contextLogger, maskWalletAddress } from '../utils/logger';

export interface OnChainRoundState {
  roundId: string;
  oracleYield: number;
  isFinalized: boolean;
}

export interface OnChainReader {
  getRoundState(roundId: string): Promise<OnChainRoundState>;
  /** Returns wallet addresses of players still active after the latest resolve_round. */
  getActivePlayers(contractId: string): Promise<string[]>;
  /** Returns the single on-chain winner address once the game is finished, or null. */
  getWinner(contractId: string): Promise<string | null>;
}

export class NoOpOnChainReader implements OnChainReader {
  async getRoundState(roundId: string): Promise<OnChainRoundState> {
    return { roundId, oracleYield: 0, isFinalized: false };
  }
  async getActivePlayers(_contractId: string): Promise<string[]> {
    return [];
  }
  async getWinner(_contractId: string): Promise<string | null> {
    return null;
  }
}

/** Production implementation backed by the Soroban simulation helpers. */
export class SorobanOnChainReader implements OnChainReader {
  async getRoundState(roundId: string): Promise<OnChainRoundState> {
    return { roundId, oracleYield: 0, isFinalized: false };
  }
  async getActivePlayers(contractId: string): Promise<string[]> {
    return getOnChainActivePlayerIds(contractId);
  }
  async getWinner(contractId: string): Promise<string | null> {
    return getOnChainWinner(contractId);
  }
}

export class RoundService {
  private roundRepo: RoundRepository;
  private onChainReader: OnChainReader;
  private explicitStellarConfig: StellarConfig | undefined;
  private resolvedStellarConfig: StellarConfig | undefined;

  constructor(
    private prisma: PrismaClient,
    stellarConfig?: StellarConfig,
    onChainReader?: OnChainReader,
    private stellarRpcGateway: StellarRpcGateway = new StellarRpcGateway(),
  ) {
    this.roundRepo = new RoundRepository(prisma);
    this.onChainReader = onChainReader ?? new SorobanOnChainReader();
    this.explicitStellarConfig = stellarConfig;
  }

  /**
   * Resolved lazily (on first access), not eagerly in the constructor.
   *
   * getStellarConfig() throws outside NODE_ENV=test unless
   * SOROBAN_RPC_URL/STELLAR_NETWORK_PASSPHRASE are set, but not every
   * RoundService consumer needs on-chain config — getCommitStatus (#1383)
   * is a pure Postgres read and performs no Soroban RPC calls at all.
   * Constructing a RoundService (e.g. in createArenasRouter, or in a
   * lightweight route test that mounts the router directly) must not
   * require Stellar config to be present; only the on-chain resolve path
   * (submitOnChainResolve) actually needs it, and that's where this getter
   * is used.
   */
  private get stellarConfig(): StellarConfig {
    if (!this.resolvedStellarConfig) {
      this.resolvedStellarConfig = this.explicitStellarConfig ?? getStellarConfig();
    }
    return this.resolvedStellarConfig;
  }

  /**
   * Build, sign, submit, and confirm a resolve_round call on the arena contract.
   * Returns the on-chain round number on success.
   */
  private async submitOnChainResolve(
    contractId: string,
    roundNumber: number,
  ): Promise<number> {
    const signerSecret = process.env.ARENA_ADMIN_SECRET;

    if (!signerSecret) {
      throw new Error("ARENA_ADMIN_SECRET is not configured. Cannot submit on-chain resolve_round.");
    }

    const server = this.stellarRpcGateway.rpcServer;
    const signer = Keypair.fromSecret(signerSecret);
    const sourceAccount = await this.stellarRpcGateway.getAccount(signer.publicKey(), "RoundService.submitOnChainResolve");
    const contract = new Contract(contractId);

    const tx = new TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase: this.stellarConfig.networkPassphrase,
    })
      .addOperation(contract.call("resolve_round", xdr.ScVal.scvU32(roundNumber)))
      .setTimeout(60)
      .build();

    const simulated = await this.stellarRpcGateway.simulateTransaction(tx);
    if (simulated.error) {
      throw new Error(`resolve_round simulation failed: ${simulated.error}`);
    }
    if (!("result" in simulated)) {
      throw new Error("resolve_round simulation returned no result");
    }

    const prepared = TransactionBuilder.fromXDR(xdr.Transaction.toXDR(tx), this.stellarConfig.networkPassphrase).build();
    prepared.sign(signer);

    const sendResult = await this.stellarRpcGateway.sendTransaction(prepared);
    if (sendResult.status === "PENDING" || sendResult.status === "DUPLICATE") {
      const hash = sendResult.hash;
      const maxPolls = this.stellarConfig.roundConfirmMaxPolls;
      const basePollMs = this.stellarConfig.roundConfirmPollMs;
      const start = Date.now();

      for (let attempt = 0; attempt < maxPolls; attempt++) {
        // Exponential backoff with ±10 % jitter, capped at 30 s.
        const delay = Math.min(
          basePollMs * Math.pow(1.5, attempt) * (0.9 + Math.random() * 0.2),
          30_000,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));

        const elapsed = Date.now() - start;
        const status = await this.stellarRpcGateway.getTransaction(hash);

        console.info(
          `[roundService] resolve_round poll attempt=${attempt + 1}/${maxPolls} ` +
          `status=${status.status} elapsed=${elapsed}ms hash=${hash}`,
        );

        if (status.status === "SUCCESS") {
          return roundNumber;
        }
        if (status.status === "FAILED") {
          throw new Error(`resolve_round transaction failed: hash=${hash}`);
        }
      }
      throw new Error(
        `resolve_round transaction timed out after ${maxPolls} polls: hash=${hash}`,
      );
    }
    throw new Error(`resolve_round send failed: ${sendResult.status}`);
  }

  async resolveRound(input: RoundInput): Promise<RoundResolution> {
    const start = Date.now();

    try {
      const round = await this.roundRepo.findById(input.roundId);
      if (!round) throw new Error('Round not found');
      if (round.state !== RoundState.OPEN && round.state !== RoundState.CLOSED) {
        throw new Error(`Round already in state: ${round.state}`);
      }

      // Submit on-chain resolve_round BEFORE computing eliminations so that
      // the contract's authoritative state is available to read back via
      // get_players. If this fails the DB is untouched, preventing desync.
      await this.submitOnChainResolve(input.arenaContractId, round.roundNumber);

      // ── #1098: derive eliminations from on-chain PlayerState.active ──────
      // The Soroban contract is the single source of truth for the
      // minority-wins elimination logic. Reading get_players() after
      // resolve_round is confirmed eliminates any risk of TypeScript
      // re-implementation diverging from on-chain behaviour (tie-breaking,
      // no-submission handling, etc.).
      const activePlayerIds = await this.onChainReader.getActivePlayers(input.arenaContractId);
      const onChainWinner = await this.onChainReader.getWinner(input.arenaContractId);
      const result = buildRoundResolution(input, activePlayerIds, onChainWinner);
      const metadata: RoundMetadata = {
        playerChoices: input.playerChoices,
        oracleYield: input.oracleYield,
        randomSeed: input.randomSeed,
        resolution: result,
        // #1394: persisted verbatim (not re-derived later) so the proof
        // bundle can distinguish non-revealers from "never existed" — see
        // RoundProofBundleService and docs/round-outcome-proof-bundle.md.
        allActivePlayerIds: input.allActivePlayerIds,
      };

      await this.roundRepo.resolveAtomically(
        input.roundId,
        RoundState.RESOLVED,
        result,
        metadata
      );

      arenaStateTransitionsTotal.inc({
        from_state: round.state,
        to_state: RoundState.RESOLVED,
      });
      playersEliminatedTotal.inc(eliminatedPlayers.length);
      await refreshArenaMetrics(this.prisma);

      // Drop the now-stale arena stats cache so watchers see the resolved round
      // immediately rather than after the TTL. Best-effort — a Redis outage
      // must not fail an otherwise-successful resolution.
      await invalidateArenaStats(round.arenaId).catch(() => {});

      const duration = (Date.now() - start) / 1000;
      roundResolutionDuration.observe(duration);
      roundResolutionsTotal.inc({ status: 'success' });

      return result;
    } catch (error) {
      const duration = (Date.now() - start) / 1000;
      roundResolutionDuration.observe(duration);
      roundResolutionsTotal.inc({ status: 'error' });
      throw error;
    }
  }

  /**
   * Round-scoped commit receipt status (#1383).
   *
   * Answers "what is the status of my submit_commitment for this round?"
   * purely from data the backend already has — Round.state and the
   * resolved round's playerChoices. See backend/docs/COMMIT_RECEIPT_DESIGN.md
   * for the full state-machine rationale, including why `pending` cannot
   * currently distinguish "never submitted" from "submitted but not yet
   * indexed" (the backend does not index submit_commitment events).
   *
   * This method performs no on-chain reads — it is a read over Postgres
   * only — so it has no OnChainReadError-style failure mode; a thrown error
   * here is always an infrastructure failure (DB) and propagates to the
   * caller's asyncHandler/errorHandler as a 500, same as any other route.
   */
  async getCommitStatus(
    arenaId: string,
    roundNumber: number,
    walletAddress: string,
  ): Promise<CommitReceipt> {
    const start = Date.now();
    const log = contextLogger();
    const asOf = new Date().toISOString();

    try {
      const round = await this.roundRepo.findByArenaAndNumber(arenaId, roundNumber);

      if (!round) {
        const receipt: CommitReceipt = {
          arenaId,
          roundNumber,
          walletAddress,
          status: 'missing',
          reason: 'ROUND_NOT_FOUND',
          asOf,
        };
        this.recordCommitStatusOutcome(receipt, start, log, walletAddress);
        return receipt;
      }

      const user = await this.prisma.user.findUnique({ where: { walletAddress } });
      const playerChoice = user
        ? round.playerChoices.find((choice) => choice.userId === user.id)
        : undefined;

      let receipt: CommitReceipt;

      if (playerChoice) {
        // Accepted: duplicate delivery is naturally idempotent here —
        // playerChoices is looked up with .find (first match), so even if
        // a caller somehow produced two entries for the same userId this
        // still reports a single, clean "accepted" rather than erroring or
        // double-reporting.
        const revealedChoice =
          playerChoice.choice === 'heads' || playerChoice.choice === 'tails'
            ? playerChoice.choice
            : undefined;
        receipt = {
          arenaId,
          roundNumber,
          walletAddress,
          status: 'accepted',
          // Spread rather than assign `choice: undefined` directly — the
          // CommitReceipt type has exactOptionalPropertyTypes: true, so the
          // key must be omitted entirely when there's no valid choice, not
          // present-with-undefined.
          ...(revealedChoice !== undefined ? { choice: revealedChoice } : {}),
          asOf,
        };
      } else if (round.state === RoundState.RESOLVED || round.state === RoundState.SETTLED) {
        // Round is done and this player has no recorded choice. We cannot
        // tell "never committed" apart from "committed but missing from the
        // resolution input" — `missing` is the more honest label than
        // `expired`, which would imply positive evidence of a closed
        // window we don't actually have for a resolved round.
        receipt = {
          arenaId,
          roundNumber,
          walletAddress,
          status: 'missing',
          reason: 'NO_COMMIT_RECORDED',
          asOf,
        };
      } else if (round.state === RoundState.CLOSED) {
        receipt = { arenaId, roundNumber, walletAddress, status: 'expired', asOf };
      } else {
        // OPEN (or any future state defaulted to OPEN by parseState) with
        // no recorded choice yet: the window is still open from the
        // backend's point of view.
        receipt = { arenaId, roundNumber, walletAddress, status: 'pending', asOf };
      }

      this.recordCommitStatusOutcome(receipt, start, log, walletAddress);
      return receipt;
    } catch (error) {
      const duration = (Date.now() - start) / 1000;
      commitReceiptLookupDuration.observe(duration);
      commitReceiptLookupsTotal.inc({ status: 'error', outcome: 'failure' });
      log.error(
        {
          arenaId,
          roundNumber,
          walletAddress: maskWalletAddress(walletAddress),
          err: error,
          durationMs: Date.now() - start,
        },
        'commit-status lookup failed',
      );
      throw error;
    }
  }

  private recordCommitStatusOutcome(
    receipt: CommitReceipt,
    start: number,
    log: ReturnType<typeof contextLogger>,
    walletAddress: string,
  ): void {
    const duration = (Date.now() - start) / 1000;
    commitReceiptLookupDuration.observe(duration);
    commitReceiptLookupsTotal.inc({ status: receipt.status, outcome: 'success' });
    log.info(
      {
        arenaId: receipt.arenaId,
        roundNumber: receipt.roundNumber,
        walletAddress: maskWalletAddress(walletAddress),
        status: receipt.status,
        reason: receipt.reason,
        durationMs: Date.now() - start,
      },
      'commit-status lookup',
    );
  }

  async closeRound(roundId: string): Promise<{ state: RoundState }> {
    const round = await this.roundRepo.findById(roundId);
    if (!round) throw new Error(`Round ${roundId} not found`);
    if (round.state !== RoundState.OPEN) {
      throw new Error(`Round is not OPEN (current state: ${round.state})`);
    }
    await this.roundRepo.updateState(roundId, RoundState.CLOSED);
    arenaStateTransitionsTotal.inc({ from_state: RoundState.OPEN, to_state: RoundState.CLOSED });
    return { state: RoundState.CLOSED };
  }

}
