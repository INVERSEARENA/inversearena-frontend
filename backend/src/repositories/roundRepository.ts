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

    return this.mapRound(round);
  }

  async findById(roundId: string): Promise<RoundData | null> {
    const round = await this.prisma.round.findUnique({
      where: { id: roundId },
    });

    if (!round) return null;

    return this.mapRound(round);
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
    const offset = cursor ? this.decodeCursor(cursor) : 0;
    const rounds = await this.prisma.round.findMany({
      where: { arenaId },
      orderBy: [{ roundNumber: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      skip: offset,
    });

    const hasMore = rounds.length > limit;
    const items = rounds.slice(0, limit).map((round) => this.mapRound(round));

    return {
      items,
      cursor: hasMore ? this.encodeCursor(offset + limit) : null,
      hasMore,
    };
  }

  private encodeCursor(offset: number): string {
    return Buffer.from(JSON.stringify({ offset })).toString('base64url');
  }

  private decodeCursor(cursor: string): number {
    try {
      const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as { offset: number };
      if (typeof payload.offset !== 'number' || payload.offset < 0) return 0;
      return payload.offset;
    } catch {
      return 0;
    }
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
  }

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
