/**
 * Arena Participants Service (#1749).
 *
 * Extracts participant pagination, roster resolution, pick masking for open rounds,
 * and on-chain player syncing out of routes/arenas.ts.
 *
 * Fixes bug where participants handler constructed `participants` but returned undefined `items`.
 */

import type { PrismaClient } from "@prisma/client";
import { apiError } from "../utils/apiError";
import type { ArenaParticipant } from "../types/arena";
import { readOnChainPlayers } from "./onChainReader";
import { hasReadValue } from "../types/onChainRead";
import { isAuthorizedAdminWallet } from "./walletRoleService";

export interface NormalizedRoundMetadata {
  playerChoices?: Array<{
    userId: string;
    choice: string;
    stake: number;
  }>;
}

export function normalizeRoundMetadata(metadata: unknown): NormalizedRoundMetadata {
  if (!metadata || typeof metadata !== "object") return {};
  const meta = metadata as Record<string, unknown>;
  const playerChoices = Array.isArray(meta.playerChoices)
    ? (meta.playerChoices as Array<{ userId: string; choice: string; stake: number }>)
    : undefined;
  return { playerChoices };
}

export class ArenaParticipantsService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Returns current round participant manifest with pagination.
   * Ensures choices are hidden while the round is still OPEN to preserve minority-rule fairness.
   */
  async getParticipants(id: string, limit = 25, cursor = 0) {
    const arena = await this.prisma.arena.findUnique({
      where: { id },
      include: {
        rounds: {
          orderBy: { roundNumber: "desc" },
          take: 1,
          include: {
            eliminationLogs: {
              orderBy: { eliminatedAt: "asc" },
            },
          },
        },
      },
    });

    if (!arena) {
      throw apiError(404, "ARENA_NOT_FOUND", `Arena with ID ${id} not found`);
    }

    const latestRound = arena.rounds[0] ?? null;
    const metadata = normalizeRoundMetadata(latestRound?.metadata);
    const choices = metadata.playerChoices ?? [];
    const total = choices.length;
    const pageChoices = choices.slice(cursor, cursor + limit);
    const userIds = pageChoices.map((choice) => choice.userId);

    const users =
      userIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: userIds } },
          })
        : [];

    const userById = new Map(users.map((user) => [user.id, user]));
    const eliminatedUsers = new Set(
      latestRound?.eliminationLogs.map((entry) => entry.userId) ?? [],
    );

    const participants: ArenaParticipant[] = pageChoices.map((choice, index) => {
      const user = userById.get(choice.userId);
      const status: ArenaParticipant["status"] = eliminatedUsers.has(choice.userId)
        ? "ELIMINATED"
        : latestRound?.state === "OPEN"
          ? "READY"
          : "ACTIVE";

      return {
        id: `${latestRound?.id ?? id}:${choice.userId}:${index}`,
        walletAddress: user?.walletAddress ?? choice.userId,
        choice: latestRound?.state === "OPEN" ? null : choice.choice,
        stake: choice.stake,
        status,
        roundNumber: latestRound?.roundNumber ?? 0,
        joinedAt: (latestRound?.createdAt ?? arena.createdAt).toISOString(),
      };
    });

    return {
      arenaId: id,
      total,
      nextCursor: cursor + limit < total ? cursor + limit : null,
      hasMore: cursor + limit < total,
      items: participants, // Bug fixed: items mapped to participants array
    };
  }

  /**
   * Syncs on-chain player list to database.
   */
  async syncPlayers(id: string, caller: string) {
    const arena = await this.prisma.arena.findUnique({ where: { id } });
    if (!arena) {
      throw apiError(404, "ARENA_NOT_FOUND", `Arena with ID ${id} not found`);
    }

    const metadata = (arena.metadata as Record<string, unknown>) ?? {};
    const createdBy = metadata.createdBy as string | undefined;
    const isOwner = createdBy !== undefined && createdBy === caller;

    if (!isOwner && !isAuthorizedAdminWallet(caller)) {
      throw apiError(
        403,
        "FORBIDDEN",
        "Only the arena creator or an admin may sync players for this arena",
      );
    }

    const contractAddress = metadata.contractAddress as string | undefined;
    if (!contractAddress) {
      throw apiError(400, "NO_CONTRACT_ADDRESS", "Arena has no contract address");
    }

    const playersResult = await readOnChainPlayers(contractAddress);
    if (!hasReadValue(playersResult)) {
      throw apiError(
        503,
        "CHAIN_READ_UNAVAILABLE",
        `Could not read the on-chain player list for arena ${id}`,
      );
    }

    const onChainPlayers = playersResult.value;

    await this.prisma.user.createMany({
      data: onChainPlayers.map((walletAddress) => ({ walletAddress })),
      skipDuplicates: true,
    });

    const syncedCount = onChainPlayers.length;

    return {
      arenaId: id,
      totalPlayers: onChainPlayers.length,
      syncedPlayers: syncedCount,
      message: `Synced ${syncedCount} players from on-chain`,
    };
  }
}
