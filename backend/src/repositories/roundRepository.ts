import { Prisma, PrismaClient } from '@prisma/client';
import type {
  PaginatedResult,
  PlayerChoice,
  RoundData,
  RoundMetadata,
  RoundResolution,
} from '../types/round';
import { RoundState } from '../types/round';
import { enforcePayloadLimits } from '../validation/payloadLimits';
import { roundMetadataMismatchesTotal } from '../utils/metrics';
import { logger } from '../utils/logger';

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
        oracleYield: metadata.oracleYield ?? null,
        randomSeed: metadata.randomSeed ?? null,
        playerChoices: metadata.playerChoices ? (metadata.playerChoices as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        allActivePlayerIds: metadata.allActivePlayerIds ?? [],
        resolution: resolution ? (resolution as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
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
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Optimistic lock (#1125): claim the round first with a conditional
      // UPDATE. Two concurrent resolutions can both pass the service-level
      // state check at ReadCommitted isolation, but only one of them matches
      // this guard — the loser sees zero updated rows and aborts before any
      // elimination logs are written, preventing duplicate records.
      const claimed = await tx.round.updateMany({
        where: {
          id: roundId,
          state: { in: [RoundState.OPEN, RoundState.CLOSED] },
        },
        data: {
          state,
          oracleYield: metadata.oracleYield ?? null,
          randomSeed: metadata.randomSeed ?? null,
          playerChoices: metadata.playerChoices ? (metadata.playerChoices as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          allActivePlayerIds: metadata.allActivePlayerIds ?? [],
          resolution: resolution ? (resolution as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          metadata: this.toJsonMetadata({
            ...metadata,
            resolution,
          }),
          updatedAt: new Date(),
        },
      });

      if (claimed.count === 0) {
        throw new Error(`Round ${roundId} was already resolved by a concurrent request`);
      }

      if (resolution.eliminatedPlayers.length > 0) {
        await tx.eliminationLog.createMany({
          data: resolution.eliminatedPlayers.map((userId) => ({
            roundId,
            userId,
            reason: 'ELIMINATED_BY_ROUND',
          })),
        });
      }
    });
  }

  private mapRound(round: {
    id: string;
    arenaId: string;
    roundNumber: number;
    state: string;
    metadata: Prisma.JsonValue | null;
    oracleYield?: number | null;
    randomSeed?: string | null;
    playerChoices?: Prisma.JsonValue | null;
    allActivePlayerIds?: string[] | null;
    resolution?: Prisma.JsonValue | null;
    createdAt: Date;
    updatedAt: Date;
  }): RoundData {
    const legacyMeta = this.fromJsonMetadata(round.metadata);

    const hasTypedFields =
      (round.oracleYield !== undefined && round.oracleYield !== null) ||
      (round.randomSeed !== undefined && round.randomSeed !== null) ||
      (round.playerChoices !== undefined && round.playerChoices !== null) ||
      (round.allActivePlayerIds !== undefined && round.allActivePlayerIds !== null && round.allActivePlayerIds.length > 0) ||
      (round.resolution !== undefined && round.resolution !== null);

    if (hasTypedFields && legacyMeta) {
      this.checkAndReportMismatches(round.id, round, legacyMeta);
    }

    const oracleYield =
      round.oracleYield !== undefined && round.oracleYield !== null
        ? round.oracleYield
        : legacyMeta?.oracleYield;

    const randomSeed =
      round.randomSeed !== undefined && round.randomSeed !== null
        ? round.randomSeed
        : legacyMeta?.randomSeed;

    const playerChoices: PlayerChoice[] =
      round.playerChoices !== undefined && round.playerChoices !== null
        ? (round.playerChoices as unknown as PlayerChoice[])
        : (legacyMeta?.playerChoices ?? []);

    const allActivePlayerIds: string[] | undefined =
      round.allActivePlayerIds !== undefined && round.allActivePlayerIds !== null && round.allActivePlayerIds.length > 0
        ? round.allActivePlayerIds
        : legacyMeta?.allActivePlayerIds;

    const resolution: RoundResolution | undefined =
      round.resolution !== undefined && round.resolution !== null
        ? (round.resolution as unknown as RoundResolution)
        : legacyMeta?.resolution;

    const metadata: RoundMetadata = {
      playerChoices,
      oracleYield: oracleYield ?? 0,
      randomSeed: randomSeed ?? undefined,
      resolution: resolution ?? undefined,
      allActivePlayerIds: allActivePlayerIds ?? undefined,
    };

    return {
      id: round.id,
      arenaId: round.arenaId,
      roundNumber: round.roundNumber,
      state: this.parseState(round.state),
      playerChoices,
      oracleYield: oracleYield ?? undefined,
      randomSeed: randomSeed ?? undefined,
      resolution: resolution ?? undefined,
      metadata,
      allActivePlayerIds: allActivePlayerIds ?? undefined,
      createdAt: round.createdAt,
      updatedAt: round.updatedAt,
    };
  }

  private checkAndReportMismatches(
    roundId: string,
    typed: {
      oracleYield?: number | null;
      randomSeed?: string | null;
      playerChoices?: Prisma.JsonValue | null;
      allActivePlayerIds?: string[] | null;
      resolution?: Prisma.JsonValue | null;
    },
    legacy: RoundMetadata,
  ): void {
    if (typed.oracleYield !== undefined && typed.oracleYield !== null && legacy.oracleYield !== undefined) {
      if (typed.oracleYield !== legacy.oracleYield) {
        roundMetadataMismatchesTotal.inc({ field: 'oracleYield' });
        logger.warn(
          { event: 'round_metadata_mismatch', roundId, field: 'oracleYield', typed: typed.oracleYield, legacy: legacy.oracleYield },
          'Round metadata mismatch detected on oracleYield',
        );
      }
    }
    if (typed.randomSeed !== undefined && typed.randomSeed !== null && legacy.randomSeed !== undefined) {
      if (typed.randomSeed !== legacy.randomSeed) {
        roundMetadataMismatchesTotal.inc({ field: 'randomSeed' });
        logger.warn(
          { event: 'round_metadata_mismatch', roundId, field: 'randomSeed' },
          'Round metadata mismatch detected on randomSeed',
        );
      }
    }
    if (typed.allActivePlayerIds !== undefined && typed.allActivePlayerIds !== null && legacy.allActivePlayerIds !== undefined) {
      const typedIds = [...typed.allActivePlayerIds].sort().join(',');
      const legacyIds = [...legacy.allActivePlayerIds].sort().join(',');
      if (typedIds !== legacyIds) {
        roundMetadataMismatchesTotal.inc({ field: 'allActivePlayerIds' });
        logger.warn(
          { event: 'round_metadata_mismatch', roundId, field: 'allActivePlayerIds' },
          'Round metadata mismatch detected on allActivePlayerIds',
        );
      }
    }
    if (typed.playerChoices !== undefined && typed.playerChoices !== null && legacy.playerChoices !== undefined) {
      const typedStr = JSON.stringify(typed.playerChoices);
      const legacyStr = JSON.stringify(legacy.playerChoices);
      if (typedStr !== legacyStr) {
        roundMetadataMismatchesTotal.inc({ field: 'playerChoices' });
        logger.warn(
          { event: 'round_metadata_mismatch', roundId, field: 'playerChoices' },
          'Round metadata mismatch detected on playerChoices',
        );
      }
    }
    if (typed.resolution !== undefined && typed.resolution !== null && legacy.resolution !== undefined) {
      const typedStr = JSON.stringify(typed.resolution);
      const legacyStr = JSON.stringify(legacy.resolution);
      if (typedStr !== legacyStr) {
        roundMetadataMismatchesTotal.inc({ field: 'resolution' });
        logger.warn(
          { event: 'round_metadata_mismatch', roundId, field: 'resolution' },
          'Round metadata mismatch detected on resolution',
        );
      }
    }
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
    // #1455: reject oversized/over-nested metadata before it reaches the JSON column.
    return enforcePayloadLimits(JSON.parse(JSON.stringify(metadata)) as Prisma.InputJsonValue, "round_metadata");
  }
}

