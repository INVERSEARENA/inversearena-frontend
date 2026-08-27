import { PrismaClient } from '@prisma/client';
import { Contract, Keypair, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
// @ts-ignore
import { rpc } from "@stellar/stellar-sdk";
const { Server, Api, assembleTransaction } = rpc;
import { RoundRepository } from '../repositories/roundRepository';
import type { RoundInput, RoundMetadata, RoundResolution, Payout } from '../types/round';
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

    const server = new Server(this.stellarConfig.sorobanRpcUrl, { allowHttp: false });
    const signer = Keypair.fromSecret(signerSecret);
    const sourceAccount = await server.getAccount(signer.publicKey());
    const contract = new Contract(contractId);

    const tx = new TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase: this.stellarConfig.networkPassphrase,
    })
      .addOperation(contract.call("resolve_round", xdr.ScVal.scvU32(roundNumber)))
      .setTimeout(60)
      .build();

    const simulated = await server.simulateTransaction(tx);
    if (Api.isSimulationError(simulated)) {
      throw new Error(`resolve_round simulation failed: ${simulated.error}`);
    }
    if (!Api.isSimulationSuccess(simulated)) {
      throw new Error("resolve_round simulation returned no result");
    }

    const prepared = assembleTransaction(tx, simulated).build();
    prepared.sign(signer);

    const sendResult = await server.sendTransaction(prepared);
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
        const status = await server.getTransaction(hash);

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
      const activeSet = new Set(activePlayerIds);
      const eliminatedPlayers = input.allActivePlayerIds.filter(
        id => !activeSet.has(id)
      );

      // ── #1099: always one payout record — the single on-chain winner ──────
      // The arena contract sets exactly one winner via set_winner() and pays
      // that address the full prize pool via claim(). Creating multiple payout
      // records or splitting the pool causes on-chain submission failures.
      const payouts = await this.computePayouts(
        input.arenaContractId,
        input.playerChoices,
        eliminatedPlayers,
        input.oracleYield
      );

      const poolBalances = this.computePoolBalances(
        input.playerChoices,
        eliminatedPlayers
      );

      const result = { eliminatedPlayers, payouts, poolBalances };
      const metadata: RoundMetadata = {
        playerChoices: input.playerChoices,
        oracleYield: input.oracleYield,
        randomSeed: input.randomSeed,
        resolution: result,
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
   * Build the payout record for this round.
   *
   * The on-chain arena contract designates exactly one winner (the last
   * surviving player) who receives 100% of the prize pool via `claim()`.
   * This method reads that winner directly from on-chain via `get_winner`,
   * ensuring the backend payout record always matches the on-chain
   * entitlement and never produces under-paying or multi-winner XDRs.
   *
   * If the game is not yet finished (multi-round game still in progress)
   * there is no on-chain winner yet and we return an empty array — payout
   * records are only created at game end.
   */
  private async computePayouts(
    arenaContractId: string,
    playerChoices: RoundInput['playerChoices'],
    eliminatedPlayers: string[],
    oracleYield: number
  ): Promise<Payout[]> {
    // Attempt to read the single authoritative winner from on-chain.
    const onChainWinner = await this.onChainReader.getWinner(arenaContractId);
    if (!onChainWinner) {
      // Game is still in progress (more rounds to go); no payout yet.
      return [];
    }

    // Compute prize = all eliminated stakes + oracle yield on the total pool.
    const totalStake = playerChoices.reduce((sum, p) => sum + p.stake, 0);
    const eliminatedStake = playerChoices
      .filter(p => eliminatedPlayers.includes(p.userId))
      .reduce((sum, p) => sum + p.stake, 0);
    const prizePool = eliminatedStake * (1 + oracleYield / 100);

    // Find the on-chain winner's stake entry to add their own principal back.
    const winnerChoice = playerChoices.find(p => p.userId === onChainWinner);
    const winnerStake = winnerChoice?.stake ?? 0;

    return [{
      userId: onChainWinner,
      // Winner receives their own stake back plus the full prize pool.
      amount: winnerStake + prizePool,
    }];

    // Suppress unused-variable warning; totalStake retained for future use.
    void totalStake;
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

  private computePoolBalances(
    playerChoices: RoundInput['playerChoices'],
    eliminatedPlayers: string[]
  ): Record<string, number> {
    const balances: Record<string, number> = {};

    for (const player of playerChoices) {
      const isEliminated = eliminatedPlayers.includes(player.userId);
      balances[player.userId] = isEliminated ? 0 : player.stake;
    }

    return balances;
  }
}
