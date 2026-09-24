import { PrismaClient } from '@prisma/client';
import { Contract, Keypair, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { StellarRpcGateway } from "../../frontend/src/shared-d/services/stellarRpcGateway";

import { RoundRepository } from '../repositories/roundRepository';
import type { RoundInput, RoundMetadata, RoundResolution } from '../types/round';
import { RoundState } from '../types/round';
import {
  arenaStateTransitionsTotal,
  playersEliminatedTotal,
  refreshArenaMetrics,
  roundResolutionsTotal,
  roundResolutionDuration,
} from '../utils/metrics';
import { invalidateArenaStats } from '../cache/cacheService';
import {
  getOnChainActivePlayerIds,
  getOnChainWinner,
} from './onChainReader';
import { getStellarConfig, type StellarConfig } from '../config/stellarConfig';
import { buildRoundResolution } from '../domain/roundResolution';

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

  constructor(
    private prisma: PrismaClient,
    private stellarConfig: StellarConfig = getStellarConfig(),
    private stellarRpcGateway: StellarRpcGateway = new StellarRpcGateway(),
    onChainReader?: OnChainReader,
  ) {
    this.roundRepo = new RoundRepository(prisma);
    this.onChainReader = onChainReader ?? new SorobanOnChainReader();
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
