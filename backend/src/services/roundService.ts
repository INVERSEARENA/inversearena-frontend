import { PrismaClient } from '@prisma/client';
import { RoundRepository } from '../repositories/roundRepository';
import type { RoundInput, RoundResolution, Payout } from '../types/round';
import { RoundState } from '../types/round';
import { roundResolutionsTotal, roundResolutionDuration } from '../utils/metrics';

export class RoundService {
  private roundRepo: RoundRepository;

  constructor(private prisma: PrismaClient) {
    this.roundRepo = new RoundRepository(prisma);
  }

  async resolveRound(input: RoundInput): Promise<RoundResolution> {
    const start = Date.now();

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const round = await tx.round.findUnique({
          where: { id: input.roundId },
          include: { eliminationLogs: true },
        });

        if (!round) throw new Error('Round not found');
        if (round.state !== RoundState.OPEN && round.state !== RoundState.CLOSED) {
          throw new Error(`Round already in state: ${round.state}`);
        }

        const eliminatedPlayers = this.computeEliminations(
          input.playerChoices,
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

        await tx.eliminationLog.createMany({
          data: eliminatedPlayers.map(userId => ({
            roundId: input.roundId,
            userId,
            reason: 'ELIMINATED_BY_ROUND',
          })),
        });

        await tx.round.update({
          where: { id: input.roundId },
          data: { 
            state: RoundState.RESOLVED,
            metadata: {
              playerChoices: input.playerChoices,
              oracleYield: input.oracleYield,
              randomSeed: input.randomSeed,
              resolution: { eliminatedPlayers, payouts, poolBalances }
            },
            updatedAt: new Date() 
          },
        });

        return { eliminatedPlayers, payouts, poolBalances };
      });

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
    oracleYield: number,
    randomSeed?: string
  ): string[] {
    const eliminated: string[] = [];
    
    for (const player of playerChoices) {
      const threshold = this.calculateThreshold(player.choice, oracleYield, randomSeed);
      if (threshold < 0.5) {
        eliminated.push(player.userId);
      }
    }

    return eliminated;
  }

  private calculateThreshold(choice: string, oracleYield: number, seed?: string): number {
    const hash = this.deterministicHash(choice + oracleYield.toString() + (seed || ''));
    return (hash % 100) / 100;
  }

  private deterministicHash(input: string): number {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = ((hash << 5) - hash) + input.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
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
