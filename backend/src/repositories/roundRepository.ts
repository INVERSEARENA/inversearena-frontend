import { Prisma, PrismaClient } from '@prisma/client';
import type {
  PaginatedResult,
  RoundData,
  RoundMetadata,
  RoundResolution,
} from '../types/round';
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
      state: round.state as RoundState,
      playerChoices: [],
      createdAt: round.createdAt,
      updatedAt: round.updatedAt,
      ...this.mapRound(round),
    };
  }

  async findById(roundId: string): Promise<RoundData | null> {
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
    });

    if (!round) return null;

    return this.mapRound(round);
  }

  async updateState(roundId: string, state: RoundState): Promise<void> {
    await this.prisma.round.update({
      where: { id: roundId },
      data: {
        state,
        updatedAt: new Date(),
      },
    });
  }

  async saveResolution(
    roundId: string,
    resolution: RoundResolution,
    metadata: RoundMetadata,
  ): Promise<void> {
    await this.prisma.round.update({
      where: { id: roundId },
      data: {
        metadata: this.toJsonMetadata({
          ...metadata,
          resolution,
        }),
        updatedAt: new Date(),
      },
    });

    if (resolution.eliminatedPlayers.length > 0) {
      await this.prisma.eliminationLog.createMany({
        data: resolution.eliminatedPlayers.map((userId) => ({
          roundId,
          userId,
          reason: 'ELIMINATED_BY_ROUND',
        })),
      });
    }
  }

  async listByArenaId(
    arenaId: string,
    limit: number,
    cursor?: string,
  ): Promise<PaginatedResult<RoundData>> {
    const rounds = await this.prisma.round.findMany({
      where: { arenaId },
      orderBy: [{ roundNumber: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor
        ? {
            skip: 1,
            cursor: { id: cursor },
          }
        : {}),
    });

    const hasMore = rounds.length > limit;
    const items = rounds.slice(0, limit).map((round) => this.mapRound(round));

    return {
      items,
      cursor: hasMore ? items[items.length - 1]?.id ?? null : null,
      hasMore,
    };
  }

  async findByArenaAndNumber(
    arenaId: string,
    roundNumber: number,
  ): Promise<RoundData | null> {
    const round = await this.prisma.round.findUnique({
      where: {
        arenaId_roundNumber: {
          arenaId,
          roundNumber,
        },
      },
    });

    return round ? this.mapRound(round) : null;
  }

  async resolveAtomically(
    roundId: string,
    state: RoundState,
    resolution: RoundResolution,
    metadata: RoundMetadata,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (resolution.eliminatedPlayers.length > 0) {
        await tx.eliminationLog.createMany({
          data: resolution.eliminatedPlayers.map((userId) => ({
            roundId,
            userId,
            reason: 'ELIMINATED_BY_ROUND',
          })),
        });
      }

      await tx.round.update({
        where: { id: roundId },
        data: {
          state,
          metadata: this.toJsonMetadata({
            ...metadata,
            resolution,
          }),
          updatedAt: new Date(),
        },
      });
    });
  }

  private mapRound(round: {
    id: string;
    arenaId: string;
    roundNumber: number;
    state: string;
    metadata: Prisma.JsonValue | null;
    createdAt: Date;
    updatedAt: Date;
  }): RoundData {
    const metadata = this.fromJsonMetadata(round.metadata);

    return {
      id: round.id,
      arenaId: round.arenaId,
      roundNumber: round.roundNumber,
      state: this.parseState(round.state),
      playerChoices: metadata?.playerChoices ?? [],
      oracleYield: metadata?.oracleYield,
      randomSeed: metadata?.randomSeed,
      resolution: metadata?.resolution,
      metadata: metadata ?? undefined,
      createdAt: round.createdAt,
      updatedAt: round.updatedAt,
    };
  }

  async updateState(roundId: string, state: RoundState): Promise<void> {
    await this.prisma.round.update({
      where: { id: roundId },
      data: { state, updatedAt: new Date() },
    });
  private parseState(state: string): RoundState {
    if (Object.values(RoundState).includes(state as RoundState)) {
      return state as RoundState;
    }
    return RoundState.OPEN;
  }

  private fromJsonMetadata(metadata: Prisma.JsonValue | null): RoundMetadata | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }

    return metadata as unknown as RoundMetadata;
  }

  private toJsonMetadata(metadata: RoundMetadata): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(metadata)) as Prisma.InputJsonValue;
  }
}
