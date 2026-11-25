/**
 * Arena Query Service (#1749).
 *
 * Extracts arena discovery, filtering, search, and keyset pagination out of routes/arenas.ts.
 */

import type { PrismaClient } from "@prisma/client";
import { decodeCursorInput, encodeKeysetCursor } from "../utils/keysetPagination";
import { apiError } from "../utils/apiError";
import { getConfiguredNetwork } from "../config/network";

export interface ListArenasOptions {
  limit?: number;
  cursor?: string;
  filter?: "all" | "active" | "pending" | "closed";
  search?: string;
}

export class ArenaQueryService {
  constructor(private readonly prisma: PrismaClient) {}

  async listArenas(options: ListArenasOptions = {}) {
    const limit = options.limit ?? 25;
    const filter = options.filter ?? "all";
    const search = options.search ?? "";

    const decoded = decodeCursorInput(options.cursor);

    const where: any = { network: getConfiguredNetwork() };

    if (filter !== "all") {
      where.status = filter === "active" ? "ACTIVE" : filter === "pending" ? "PENDING" : "CLOSED";
    }

    let skip: number | undefined = undefined;

    if (decoded.mode === "keyset") {
      const lastCreatedAt = new Date(decoded.cursor.sortValues.createdAt as string);
      const lastId = decoded.cursor.id;
      where.OR = [
        { createdAt: { lt: lastCreatedAt } },
        { createdAt: lastCreatedAt, id: { lt: lastId } },
      ];
    } else if (decoded.mode === "legacy") {
      skip = decoded.offset;
    }

    const rows = await this.prisma.arena.findMany({
      where,
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

    let pageRows = rows;
    if (search) {
      const searchLower = search.toLowerCase();
      pageRows = pageRows.filter((arena) => {
        const metadata = arena.metadata as any;
        return (
          arena.id.toLowerCase().includes(searchLower) ||
          metadata?.number?.toLowerCase().includes(searchLower) ||
          metadata?.name?.toLowerCase().includes(searchLower)
        );
      });
    }

    const hasMore = pageRows.length > limit;
    const items = pageRows.slice(0, limit);

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1];
      nextCursor = encodeKeysetCursor(
        { createdAt: last.createdAt.toISOString() },
        last.id,
      );
    }

    return {
      items: items.map((arena) => ({
        id: arena.id,
        network: arena.network,
        number: (arena.metadata as any)?.number ?? `#${arena.id.substring(0, 4)}`,
        name: (arena.metadata as any)?.name ?? "Unnamed Arena",
        playersJoined: arena.pools.length,
        maxPlayers: (arena.metadata as any)?.maxPlayers ?? 100,
        roundSpeed: (arena.metadata as any)?.roundSpeed ?? "1 MIN",
        stake: (arena.metadata as any)?.entryFee ? `${(arena.metadata as any).entryFee} USDC` : "Unknown",
        poolYield: "+8.0% APY",
        status: (arena.metadata as any)?.status ?? "ACTIVE",
        badge: (arena.metadata as any)?.badge,
        isFeatured: (arena.metadata as any)?.isFeatured ?? false,
        createdAt: arena.createdAt.toISOString(),
      })),
      cursor: nextCursor,
      hasMore,
    };
  }

  async getArenaById(id: string) {
    const arena = await this.prisma.arena.findFirst({
      where: { id, network: getConfiguredNetwork() },
      include: {
        rounds: {
          orderBy: { roundNumber: "desc" },
        },
        pools: true,
      },
    });

    if (!arena) {
      throw apiError(404, "ARENA_NOT_FOUND", `Arena with ID ${id} not found`);
    }

    return arena;
  }
}
