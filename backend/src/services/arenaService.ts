import { createHash, randomUUID } from "crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import type {
  ArenaCreationResult,
  ArenaStreamEvent,
  CreateArenaInput,
} from "../types/arena";
import { ArenaStatsService } from "./arenaStatsService";

interface ArenaSnapshot {
  arenaId: string;
  currentRound: number;
  playerCount: number;
  survivorCount: number;
  status: string;
  recentEliminations: Array<{
    id: string;
    userId: string;
    roundNumber: number;
    reason: string | null;
    eliminatedAt: string;
  }>;
  lastRoundState: string | null;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function toBase32(input: Buffer): string {
  let bits = "";
  for (const byte of input.values()) {
    bits += byte.toString(2).padStart(8, "0");
  }

  let output = "";
  for (let offset = 0; offset < bits.length; offset += 5) {
    const chunk = bits.slice(offset, offset + 5);
    if (chunk.length < 5) {
      break;
    }
    output += BASE32_ALPHABET[Number.parseInt(chunk, 2)];
  }

  return output;
}

function makeContractId(seed: string): string {
  const digest = createHash("sha256").update(seed).digest();
  const base32 = toBase32(digest).padEnd(55, "A").slice(0, 55);
  return `C${base32}`;
}

export class ArenaService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly statsService = new ArenaStatsService(prisma),
  ) {}

  async createArena(
    input: CreateArenaInput,
    createdBy: string,
  ): Promise<ArenaCreationResult> {
    const arenaId = makeContractId(
      `${createdBy}:${input.name}:${input.joinDeadline}:${input.stakeToken}:${randomUUID()}`,
    );

    const metadata: Prisma.InputJsonValue = JSON.parse(
      JSON.stringify({
        name: input.name,
        entryFee: input.entryFee,
        maxPlayers: input.maxPlayers,
        joinDeadline: input.joinDeadline,
        stakeToken: input.stakeToken,
        createdBy,
        contractAddress: arenaId,
        deployment: {
          status: "queued",
          factoryContractId: process.env.ARENA_FACTORY_CONTRACT_ID ?? null,
        },
      }),
    ) as Prisma.InputJsonValue;

    const arena = await this.prisma.arena.create({
      data: {
        id: arenaId,
        metadata,
      },
    });

    return {
      id: arena.id,
      metadata: (arena.metadata as Record<string, unknown> | null) ?? null,
      createdAt: arena.createdAt.toISOString(),
      updatedAt: arena.updatedAt.toISOString(),
    };
  }

  async getSnapshot(arenaId: string): Promise<ArenaSnapshot> {
    const arena = await this.prisma.arena.findUnique({
      where: { id: arenaId },
      include: {
        rounds: {
          orderBy: { roundNumber: "asc" },
          include: {
            eliminationLogs: {
              orderBy: { eliminatedAt: "asc" },
            },
          },
        },
      },
    });

    if (!arena) {
      throw new Error(`Arena with ID ${arenaId} not found`);
    }

    const stats = await this.statsService.getArenaStats(arenaId);
    const lastRound = arena.rounds.at(-1) ?? null;
    const recentEliminations = arena.rounds.flatMap((round) =>
      round.eliminationLogs.map((log) => ({
        id: log.id,
        userId: log.userId,
        roundNumber: round.roundNumber,
        reason: log.reason,
        eliminatedAt: log.eliminatedAt.toISOString(),
      })),
    );

    return {
      arenaId,
      currentRound: stats.currentRound,
      playerCount: stats.playerCount,
      survivorCount: stats.survivorCount,
      status: stats.status,
      recentEliminations,
      lastRoundState: lastRound?.state ?? null,
    };
  }

  buildStreamEvent(
    type: ArenaStreamEvent["type"],
    arenaId: string,
    payload: Record<string, unknown>,
    sequence: number,
  ): ArenaStreamEvent {
    return {
      type,
      arenaId,
      payload,
      sequence,
      createdAt: new Date().toISOString(),
    };
  }
}
