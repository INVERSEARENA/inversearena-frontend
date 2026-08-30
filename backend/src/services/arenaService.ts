import { createHash, randomUUID } from "crypto";
import { PrismaClient, Prisma } from "@prisma/client";
import {
  Address,
  Transaction,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
// @ts-ignore
import { rpc } from "@stellar/stellar-sdk";
const { Server } = rpc;
import type {
  ArenaCreationResult,
  ArenaStreamEvent,
  CreateArenaInput,
} from "../types/arena";
import { getStellarConfig } from "../config/stellarConfig";
import { ArenaStatsService } from "./arenaStatsService";

const CONTRACT_ID_REGEX = /^C[A-Z2-7]{55}$/;
const TX_HASH_REGEX = /^[0-9a-f]{64}$/i;
const FACTORY_CREATE_POOL_FN = "create_pool";

let rpcServer: rpc.Server | null = null;

function getRpcServer(): rpc.Server {
  if (!rpcServer) {
    const url = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
    rpcServer = new Server(url, { allowHttp: false });
  }
  return rpcServer;
}

/**
 * Test seam: swaps the module-level RPC singleton so deployment-verification
 * tests can drive `confirmArenaDeployment` without a live network. Pass `null`
 * to restore the real server.
 */
export function setRpcServerForTest(server: rpc.Server | null): void {
  rpcServer = server;
}

/**
 * Asserts that `envelopeXdr` is a single `create_pool` invocation against the
 * configured factory contract (#1342).
 *
 * A successful transaction whose return value happens to decode to an Address
 * is not proof of an arena deployment — any contract the caller controls can
 * return one. Only the invoked contract ID and function name identify the real
 * factory flow, so both are checked before the return value is trusted.
 */
function assertInvokedFactoryCreatePool(
  envelopeXdr: xdr.TransactionEnvelope | string | undefined,
  factoryContractId: string,
  txHash: string,
): void {
  if (!envelopeXdr) {
    throw new Error(
      `Arena deployment transaction ${txHash} has no envelope to verify against the factory contract`,
    );
  }

  const { networkPassphrase } = getStellarConfig();
  let parsed: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    parsed = TransactionBuilder.fromXDR(
      typeof envelopeXdr === "string" ? envelopeXdr : envelopeXdr.toXDR("base64"),
      networkPassphrase,
    );
  } catch {
    throw new Error(`Arena deployment transaction ${txHash} envelope could not be parsed`);
  }

  const tx = parsed instanceof Transaction ? parsed : parsed.innerTransaction;

  const invocations = tx.operations.filter(
    (op): op is typeof op & { type: "invokeHostFunction"; func: xdr.HostFunction } =>
      op.type === "invokeHostFunction" && Boolean((op as { func?: xdr.HostFunction }).func),
  );

  if (invocations.length !== 1) {
    throw new Error(
      `Arena deployment transaction ${txHash} must contain exactly one contract invocation`,
    );
  }

  const func = invocations[0]!.func;
  if (func.switch().name !== "hostFunctionTypeInvokeContract") {
    throw new Error(`Arena deployment transaction ${txHash} does not invoke a contract`);
  }

  const invoke = func.invokeContract();
  const invokedContractId = Address.fromScAddress(invoke.contractAddress()).toString();
  if (invokedContractId !== factoryContractId) {
    throw new Error(
      `Arena deployment transaction ${txHash} did not invoke the arena factory contract`,
    );
  }

  if (invoke.functionName().toString() !== FACTORY_CREATE_POOL_FN) {
    throw new Error(
      `Arena deployment transaction ${txHash} did not call ${FACTORY_CREATE_POOL_FN} on the arena factory`,
    );
  }
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
    if (!factoryContractId || !CONTRACT_ID_REGEX.test(factoryContractId)) {
      throw new Error(
        "ARENA_FACTORY_CONTRACT_ID is not configured with a valid Soroban contract ID",
      );
    }

    const server = getRpcServer();
    const tx = await server.getTransaction(txHash);

    if (tx.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`Arena deployment transaction ${txHash} did not succeed on-chain`);
    }

    // A successful transaction is not enough: verify it actually invoked
    // `create_pool` on the configured factory before trusting its return value.
    assertInvokedFactoryCreatePool(tx.envelopeXdr, factoryContractId, txHash);

    if (!tx.returnValue) {
      throw new Error(`Arena deployment transaction ${txHash} returned no arena address`);
    }

    // `scValToNative` already renders an ScAddress as its strkey string; passing
    // that string on to `Address.fromScAddress` throws "Unsupported address type".
    const decodedReturn = scValToNative(tx.returnValue);
    const arenaId =
      typeof decodedReturn === "string" ? decodedReturn : String(decodedReturn);
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
