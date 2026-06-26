import { PrismaClient } from '@prisma/client';
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

export class RoundService {
  private roundRepo: RoundRepository;

  constructor(private prisma: PrismaClient) {
    this.roundRepo = new RoundRepository(prisma);
  }

  async resolveRound(input: RoundInput): Promise<RoundResolution> {
    const start = Date.now();

    try {
      const round = await this.roundRepo.findById(input.roundId);
      if (!round) throw new Error('Round not found');
      if (round.state !== RoundState.OPEN && round.state !== RoundState.CLOSED) {
        throw new Error(`Round already in state: ${round.state}`);
      }

      const eliminatedPlayers = this.computeEliminations(
        input.playerChoices,
        input.allActivePlayerIds,
        input.oracleYield,
        input.randomSeed
      );

      const payouts = this.computePayouts(
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

  private computeEliminations(
    playerChoices: RoundInput['playerChoices'],
    allActivePlayerIds: string[],
    _oracleYield: number,
    _randomSeed?: string
  ): string[] {
    const headCount = playerChoices.filter(p => p.choice === 'heads').length;
    const tailCount = playerChoices.filter(p => p.choice === 'tails').length;

    // A single remaining player survives automatically
    if (headCount + tailCount === 1 && allActivePlayerIds.length === 1) {
      return [];
    }

    if (headCount === tailCount) {
      return allActivePlayerIds.filter(
        id => !playerChoices.some(p => p.userId === id)
      );
    }

    const majorityChoice = headCount > tailCount ? 'heads' : 'tails';
    const submittedIds = new Set(playerChoices.map(p => p.userId));

    return [
      ...playerChoices.filter(p => p.choice === majorityChoice).map(p => p.userId),
      ...allActivePlayerIds.filter(id => !submittedIds.has(id)),
    ];
  }

  private computePayouts(
    playerChoices: RoundInput['playerChoices'],
    eliminatedPlayers: string[],
    oracleYield: number
  ): Payout[] {
    const winners = playerChoices.filter(p => !eliminatedPlayers.includes(p.userId));
    const eliminatedStake = playerChoices
      .filter(p => eliminatedPlayers.includes(p.userId))
      .reduce((sum, p) => sum + p.stake, 0);

    if (winners.length === 0) return [];

    const prizePool = eliminatedStake * (1 + oracleYield / 100);
    const payoutPerWinner = prizePool / winners.length;

    return winners.map(w => ({
      userId: w.userId,
      amount: w.stake + payoutPerWinner,
    }));
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
