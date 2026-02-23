import { PrismaClient } from '@prisma/client';
import type { RoundData, PlayerChoice, RoundResolution } from '../types/round';
import { RoundState } from '../types/round';

export class RoundRepository {
  constructor(private prisma: PrismaClient) {}

  async create(arenaId: string, roundNumber: number): Promise<RoundData> {
    const round = await this.prisma.round.create({
      data: {
        arenaId,
        roundNumber,
      },
    });

    return {
      id: round.id,
      arenaId: round.arenaId,
      roundNumber: round.roundNumber,
      state: RoundState.OPEN,
      playerChoices: [],
      createdAt: round.createdAt,
      updatedAt: round.updatedAt,
    };
  }

  async findById(roundId: string): Promise<RoundData | null> {
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
    });

    if (!round) return null;

    return {
      id: round.id,
      arenaId: round.arenaId,
      roundNumber: round.roundNumber,
      state: RoundState.OPEN,
      playerChoices: [],
      createdAt: round.createdAt,
      updatedAt: round.updatedAt,
    };
  }

  async updateState(roundId: string, state: RoundState): Promise<void> {
    await this.prisma.round.update({
      where: { id: roundId },
      data: { updatedAt: new Date() },
    });
  }

  async saveResolution(roundId: string, resolution: RoundResolution): Promise<void> {
    await this.prisma.eliminationLog.createMany({
      data: resolution.eliminatedPlayers.map(userId => ({
        roundId,
        userId,
        reason: 'ELIMINATED_BY_ROUND',
      })),
    });
  }
}
