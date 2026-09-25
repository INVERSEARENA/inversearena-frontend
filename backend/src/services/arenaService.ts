import { createHash, randomUUID } from "crypto";
import { PrismaClient, Prisma } from "@prisma/client";
import {
  Address,
  Transaction,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { StellarRpcGateway } from "../../frontend/src/shared-d/services/stellarRpcGateway";

import type {
  ArenaCreationResult,
  ArenaStreamEvent,
  CreateArenaInput,
} from "../types/arena";
import { getStellarConfig } from "../config/stellarConfig";
import { ArenaStatsService } from "./arenaStatsService";
import { enforcePayloadLimits } from "../validation/payloadLimits";
import { ArenaProjectionCheckpointStore } from "./projection/arenaProjectionCheckpointStore";
import { initialArenaProjection, type ArenaProjectionState } from "./projection/arenaProjectionFold";
import { replayArenaProjection, type ArenaReplayOptions } from "./projection/arenaProjectionReplay";

const CONTRACT_ID_REGEX = /^C[A-Z2-7]{55}$/;
const TX_HASH_REGEX = /^[0-9a-f]{64}$/i;
const FACTORY_CREATE_POOL_FN = "create_pool";





/**
 * Test seam: swaps the module-level RPC singleton so deployment-verification
 * tests can drive `confirmArenaDeployment` without a live network. Pass `null`
 * to restore the real server.
 */


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

/**
 * Response shape for the canonical checkpointed projection (#1382). This is
 * additive — it does not change `ArenaSnapshot`/`getSnapshot()`, which
 * remains the existing REST/SSE contract untouched by this feature.
 */
export interface ArenaProjectionResponse {
  arenaId: string;
  network: string;
  /** "not_started" means no checkpoint row exists yet — replay has never run for this arena/network. */
  status: "not_started" | "idle" | "replaying" | "caught_up" | "failed";
  lastLedgerSequence: number | null;
  projection: ArenaProjectionState;
}

export class ArenaService {
  private readonly projectionCheckpoints: ArenaProjectionCheckpointStore;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly statsService = new ArenaStatsService(prisma),
    private readonly stellarRpcGateway = new StellarRpcGateway(),
  ) {
    this.projectionCheckpoints = new ArenaProjectionCheckpointStore(prisma);
  }

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

    const tx = await this.stellarRpcGateway.getTransaction(txHash);

    if (tx.status !== "SUCCESS") {
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

    // #1455: bound the persisted JSON before the write, never after.
    const metadata: Prisma.InputJsonValue = enforcePayloadLimits(JSON.parse(
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
    ) as Prisma.InputJsonValue, "arena_metadata");

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

  /**
   * Read the canonical checkpointed projection for an arena (#1382). Reads
   * whatever checkpoint row currently exists without triggering a replay —
   * callers that need a fresh/complete projection should call
   * `triggerProjectionReplay` first (or rely on a scheduled replay job; see
   * docs/projection-checkpoint-replay.md, "Open questions").
   *
   * `status: "not_started"` (a status value that does not appear in the DB
   * — it's synthesized here) distinguishes "replay has never run for this
   * arena" from a checkpoint row that genuinely reflects an in-progress or
   * completed replay, so callers can tell "no data yet" apart from "stale
   * but real data" (see design note, "Stale reads").
   */
  async getProjection(arenaId: string): Promise<ArenaProjectionResponse> {
    const network = getStellarConfig().networkPassphrase;
    const checkpoint = await this.projectionCheckpoints.load(arenaId, network);

    if (!checkpoint) {
      return {
        arenaId,
        network,
        status: "not_started",
        lastLedgerSequence: null,
        projection: initialArenaProjection(arenaId),
      };
    }

    return {
      arenaId,
      network,
      status: checkpoint.status,
      lastLedgerSequence: checkpoint.lastLedgerSequence,
      projection: checkpoint.projectionState,
    };
  }

  /**
   * Trigger a checkpointed replay for an arena, resuming from its last
   * checkpoint (or from `options.genesisLedger` if this is the first
   * replay). This is the write path backing `getProjection`; kept as a
   * separate method so read-only callers (e.g. a status endpoint) don't
   * accidentally kick off a replay just by reading.
   */
  async triggerProjectionReplay(arenaId: string, options?: ArenaReplayOptions) {
    return replayArenaProjection(this.prisma, arenaId, options);
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
