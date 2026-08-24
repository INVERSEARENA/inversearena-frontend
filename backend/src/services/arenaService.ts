import { createHash, randomUUID } from "crypto";
import { PrismaClient, Prisma } from "@prisma/client";
import { Address, scValToNative } from "@stellar/stellar-sdk";
// @ts-ignore
import { rpc } from "@stellar/stellar-sdk";
const { Server } = rpc;
import type {
  ArenaCreationResult,
  ArenaStreamEvent,
  CreateArenaInput,
} from "../types/arena";
import { ArenaStatsService } from "./arenaStatsService";

const CONTRACT_ID_REGEX = /^C[A-Z2-7]{55}$/;
const TX_HASH_REGEX = /^[0-9a-f]{64}$/i;

let rpcServer: rpc.Server | null = null;

function getRpcServer(): rpc.Server {
  if (!rpcServer) {
    const url = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
    rpcServer = new Server(url, { allowHttp: false });
  }
  return rpcServer;
}

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

export class ArenaService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly statsService = new ArenaStatsService(prisma),
  ) {}

  /**
   * Confirms an arena deployment and persists it under its real contract address.
   *
   * The factory's `create_pool` requires the host's own signature (it moves
   * their stake), so the backend cannot deploy on the caller's behalf. The
   * caller must submit `create_pool` on-chain themselves and pass us the
   * resulting txHash; we verify the transaction succeeded against the
   * configured factory contract and take the deployed arena address from its
   * return value — never inventing one — before writing the DB row.
   */
  async confirmArenaDeployment(
    input: CreateArenaInput,
    createdBy: string,
    txHash: string,
  ): Promise<ArenaCreationResult> {
    if (!TX_HASH_REGEX.test(txHash)) {
      throw new Error("Invalid transaction hash");
    }

    const factoryContractId = process.env.ARENA_FACTORY_CONTRACT_ID ?? null;

    const server = getRpcServer();
    const tx = await server.getTransaction(txHash);

    if (tx.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`Arena deployment transaction ${txHash} did not succeed on-chain`);
    }

    if (!tx.returnValue) {
      throw new Error(`Arena deployment transaction ${txHash} returned no arena address`);
    }

    const arenaId = Address.fromScAddress(scValToNative(tx.returnValue)).toString();
    if (!CONTRACT_ID_REGEX.test(arenaId)) {
      throw new Error("Deployed arena address is not a valid Soroban contract ID");
    }

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
          status: "confirmed",
          txHash,
          factoryContractId,
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
    const arena = await this.prisma.$transaction(
      (tx) => tx.arena.findUnique({
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
      }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    const stats = await this.statsService.getArenaStats(arenaId);

    if (!arena) {
      throw new Error(`Arena with ID ${arenaId} not found`);
    }

    const lastRound = arena.rounds.at(-1) ?? null;
    type RoundWithLogs = (typeof arena.rounds)[number];
    type EliminationLog = RoundWithLogs["eliminationLogs"][number];
    const recentEliminations = arena.rounds.flatMap((round: RoundWithLogs) =>
      round.eliminationLogs.map((log: EliminationLog) => ({
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
