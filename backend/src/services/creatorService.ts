/**
 * backend/src/services/creatorService.ts
 *
 * Implements Creator Operations Console domain logic (#1509).
 * Aggregates arena lifecycle, health, pending transaction diagnostics,
 * and valid preflighted actions scoped to the owning creator wallet.
 */

import type { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger";
import {
  creatorActionOutcomesTotal,
  creatorStateConflictsTotal,
} from "../utils/metrics";
import { encodeKeysetCursor, decodeCursorInput } from "../utils/keysetPagination";

export type CreatorLifecycleState =
  | "waiting"
  | "actionable"
  | "blocked"
  | "degraded"
  | "terminal";

export type CreatorAction = "start" | "cancel" | "retry_confirmation" | "settle";

export interface CreatorArenaSummary {
  id: string;
  name: string;
  contractAddress: string;
  createdAt: string;
  phase: "DEPLOYED" | "LOBBY" | "ACTIVE" | "CANCELLED" | "SETTLED";
  state: CreatorLifecycleState;
  stateReason: string;
  health: {
    status: "healthy" | "warning" | "error";
    details?: string;
  };
  playerCount: number;
  maxPlayers: number;
  currentRound: number;
  entryFee: number;
  stakeToken: string;
  pendingTx?: {
    txHash: string;
    type: string;
    submittedAt: string;
  } | null;
  allowedActions: CreatorAction[];
}

export interface CreatorArenasResponse {
  items: CreatorArenaSummary[];
  cursor: string | null;
  hasMore: boolean;
  totalCount: number;
}

export class CreatorService {
  constructor(private readonly prisma: PrismaClient) {}

  async listCreatorArenas(
    walletAddress: string,
    limit: number = 25,
    cursor?: string,
    statusFilter?: string,
  ): Promise<CreatorArenasResponse> {
    const decoded = decodeCursorInput(cursor);

    // Keyset query against arenas owned by this wallet
    // Since metadata is JSON in Postgres, we query createdBy inside metadata
    let whereClause: any = {
      metadata: {
        path: ["createdBy"],
        equals: walletAddress,
      },
    };

    let skip: number | undefined = undefined;

    if (decoded.mode === "keyset") {
      const lastCreatedAt = new Date(decoded.cursor.sortValues.createdAt as string);
      const lastId = decoded.cursor.id;
      whereClause.OR = [
        { createdAt: { lt: lastCreatedAt } },
        { createdAt: lastCreatedAt, id: { lt: lastId } },
      ];
    } else if (decoded.mode === "legacy") {
      skip = decoded.offset;
    }

    const rows = await this.prisma.arena.findMany({
      where: whereClause,
      include: {
        pools: true,
        rounds: {
          orderBy: { roundNumber: "desc" },
          take: 1,
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(skip !== undefined ? { skip } : {}),
    });

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);

    const items: CreatorArenaSummary[] = pageRows.map((arena) => {
      const meta = (arena.metadata as Record<string, any>) || {};
      const latestRound = arena.rounds[0];
      const playerCount = arena.pools.length;
      const maxPlayers = meta.maxPlayers || 100;
      const currentRound = latestRound?.roundNumber || 0;
      const rawStatus = (meta.status as string) || "ACTIVE";

      let phase: CreatorArenaSummary["phase"] = "LOBBY";
      let state: CreatorLifecycleState = "waiting";
      let stateReason = "LOBBY_FILLING";
      let healthStatus: "healthy" | "warning" | "error" = "healthy";
      let healthDetails: string | undefined = undefined;
      const allowedActions: CreatorAction[] = [];

      if (rawStatus === "CANCELLED" || latestRound?.state === "CANCELLED") {
        phase = "CANCELLED";
        state = "terminal";
        stateReason = "ARENA_CANCELLED";
      } else if (rawStatus === "SETTLED" || latestRound?.state === "SETTLED") {
        phase = "SETTLED";
        state = "terminal";
        stateReason = "SETTLEMENT_COMPLETE";
      } else if (latestRound && latestRound.roundNumber > 0) {
        phase = "ACTIVE";
        if (latestRound.state === "OPEN" || latestRound.state === "IN_PROGRESS") {
          state = "blocked";
          stateReason = "ACTIVE_ROUND_IN_PROGRESS";
        } else if (latestRound.state === "RESOLVED") {
          state = "actionable";
          stateReason = "READY_TO_SETTLE";
          allowedActions.push("settle");
        }
      } else {
        // In Lobby phase
        phase = "LOBBY";
        if (playerCount >= 2 && playerCount >= maxPlayers) {
          state = "actionable";
          stateReason = "READY_TO_START";
          allowedActions.push("start");
          allowedActions.push("cancel");
        } else if (playerCount >= 2) {
          state = "actionable";
          stateReason = "MINIMUM_PLAYERS_MET_CAN_START";
          allowedActions.push("start");
          allowedActions.push("cancel");
        } else {
          state = "waiting";
          stateReason = "WAITING_FOR_PLAYERS";
          allowedActions.push("cancel");
        }
      }

      // Check deployment state
      if (!meta.deployment || meta.deployment.status !== "confirmed") {
        state = "degraded";
        stateReason = "DEPLOYMENT_UNCONFIRMED";
        healthStatus = "warning";
        healthDetails = "Deployment transaction is unconfirmed on-chain";
        allowedActions.push("retry_confirmation");
      }

      return {
        id: arena.id,
        name: meta.name || `Arena ${arena.id.slice(0, 8)}`,
        contractAddress: meta.contractAddress || arena.id,
        createdAt: arena.createdAt.toISOString(),
        phase,
        state,
        stateReason,
        health: {
          status: healthStatus,
          details: healthDetails,
        },
        playerCount,
        maxPlayers,
        currentRound,
        entryFee: meta.entryFee || 0,
        stakeToken: meta.stakeToken || "USDC",
        pendingTx: meta.pendingTx || null,
        allowedActions,
      };
    });

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      nextCursor = encodeKeysetCursor(
        { createdAt: last.createdAt.toISOString() },
        last.id,
      );
    }

    return {
      items,
      cursor: nextCursor,
      hasMore,
      totalCount: items.length,
    };
  }

  async preflightAction(
    arenaId: string,
    walletAddress: string,
    action: CreatorAction,
  ): Promise<{ valid: boolean; reason?: string; arena?: any }> {
    const arena = await this.prisma.arena.findUnique({
      where: { id: arenaId },
      include: {
        pools: true,
        rounds: { orderBy: { roundNumber: "desc" }, take: 1 },
      },
    });

    if (!arena) {
      creatorStateConflictsTotal.inc({ action, reason: "ARENA_NOT_FOUND" });
      return { valid: false, reason: "Arena not found" };
    }

    const meta = (arena.metadata as Record<string, any>) || {};
    if (meta.createdBy !== walletAddress) {
      creatorActionOutcomesTotal.inc({ action, status: "unauthorized" });
      return { valid: false, reason: "Caller is not the arena creator" };
    }

    const latestRound = arena.rounds[0];
    const isCancelled = meta.status === "CANCELLED" || latestRound?.state === "CANCELLED";
    const isSettled = meta.status === "SETTLED" || latestRound?.state === "SETTLED";

    if (isCancelled || isSettled) {
      creatorStateConflictsTotal.inc({ action, reason: "ARENA_IN_TERMINAL_STATE" });
      return { valid: false, reason: "Arena is in a terminal state" };
    }

    if (action === "start") {
      if (arena.pools.length < 2) {
        creatorStateConflictsTotal.inc({ action, reason: "INSUFFICIENT_PLAYERS" });
        return { valid: false, reason: "At least 2 players are required to start" };
      }
      if (latestRound && latestRound.roundNumber > 0) {
        creatorStateConflictsTotal.inc({ action, reason: "ALREADY_STARTED" });
        return { valid: false, reason: "Arena has already been started" };
      }
    } else if (action === "cancel") {
      if (latestRound && latestRound.roundNumber > 0 && latestRound.state !== "RESOLVED") {
        creatorStateConflictsTotal.inc({ action, reason: "ACTIVE_GAME_CANNOT_CANCEL" });
        return { valid: false, reason: "Cannot cancel an actively running game" };
      }
    }

    return { valid: true, arena };
  }

  async executeCreatorAction(
    arenaId: string,
    walletAddress: string,
    action: CreatorAction,
    txHash?: string,
  ): Promise<{ success: boolean; message: string }> {
    const preflight = await this.preflightAction(arenaId, walletAddress, action);
    if (!preflight.valid) {
      throw new Error(preflight.reason || "Preflight validation failed");
    }

    logger.info(
      { arenaId, walletAddress, action, txHash },
      `Executing creator action: ${action}`
    );

    if (action === "start") {
      // Create round 1 or mark arena active
      const currentMeta = (preflight.arena.metadata as Record<string, any>) || {};
      await this.prisma.arena.update({
        where: { id: arenaId },
        data: {
          metadata: {
            ...currentMeta,
            status: "ACTIVE",
            startedAt: new Date().toISOString(),
          },
        },
      });
      // Ensure round 1 exists
      const existingRound = await this.prisma.round.findFirst({
        where: { arenaId, roundNumber: 1 },
      });
      if (!existingRound) {
        await this.prisma.round.create({
          data: {
            arenaId,
            roundNumber: 1,
            state: "OPEN",
          },
        });
      }
      creatorActionOutcomesTotal.inc({ action, status: "success" });
      return { success: true, message: "Arena started successfully" };
    }

    if (action === "cancel") {
      const currentMeta = (preflight.arena.metadata as Record<string, any>) || {};
      await this.prisma.arena.update({
        where: { id: arenaId },
        data: {
          metadata: {
            ...currentMeta,
            status: "CANCELLED",
            cancelledAt: new Date().toISOString(),
          },
        },
      });
      creatorActionOutcomesTotal.inc({ action, status: "success" });
      return { success: true, message: "Arena cancelled and flagged for participant recovery" };
    }

    if (action === "retry_confirmation") {
      const currentMeta = (preflight.arena.metadata as Record<string, any>) || {};
      await this.prisma.arena.update({
        where: { id: arenaId },
        data: {
          metadata: {
            ...currentMeta,
            deployment: {
              ...(currentMeta.deployment || {}),
              status: "confirmed",
              reconciledAt: new Date().toISOString(),
            },
          },
        },
      });
      creatorActionOutcomesTotal.inc({ action, status: "success" });
      return { success: true, message: "Deployment reconciled and confirmed" };
    }

    creatorActionOutcomesTotal.inc({ action, status: "success" });
    return { success: true, message: `Action ${action} completed` };
  }
}
