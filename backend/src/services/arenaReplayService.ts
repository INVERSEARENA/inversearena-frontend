/**
 * Arena Replay Service (#1395)
 *
 * Provides historical arena replay with stable event ordering.
 * Ensures the same ledger range always returns the same ordered replay.
 */

import { PrismaClient, type Round, type EliminationLog } from "@prisma/client";

export interface ReplayEvent {
  id: string;
  type: "round_started" | "round_resolved" | "player_eliminated" | "winner_declared" | "arena_cancelled";
  timestamp: string;
  ledgerSequence: number;
  data: Record<string, unknown>;
}

export interface ArenaReplayResult {
  arenaId: string;
  events: ReplayEvent[];
  totalEvents: number;
  hasMore: boolean;
  cursor: string | null;
}

export class ArenaReplayService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Get ordered replay events for an arena within a ledger range.
   * The same ledger range always returns the same ordered replay.
   */
  async getReplay(
    arenaId: string,
    options: {
      fromLedger?: number;
      toLedger?: number;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<ArenaReplayResult> {
    const { fromLedger, toLedger, limit = 100, cursor } = options;

    // Build the query for rounds and elimination logs
    const rounds = await this.prisma.round.findMany({
      where: {
        arenaId,
        ...(fromLedger || toLedger
          ? {
              metadata: {
                path: ["ledgerSequence"],
                gte: fromLedger,
                lte: toLedger,
              },
            }
          : {}),
      },
      include: {
        eliminationLogs: true,
      },
      orderBy: { roundNumber: "asc" },
    });

    // Convert to replay events with stable ordering
    const events: ReplayEvent[] = [];

    for (const round of rounds) {
      const metadata = (round.metadata as Record<string, unknown>) ?? {};
      const ledgerSequence = (metadata.ledgerSequence as number) ?? 0;

      // Round started event
      events.push({
        id: `round_started_${round.id}`,
        type: "round_started",
        timestamp: round.createdAt.toISOString(),
        ledgerSequence,
        data: {
          roundNumber: round.roundNumber,
          state: round.state,
          metadata: round.metadata,
        },
      });

      // Elimination events (ordered by eliminatedAt for stability)
      const sortedEliminations = [...round.eliminationLogs].sort(
        (a, b) => a.eliminatedAt.getTime() - b.eliminatedAt.getTime(),
      );

      for (const elimination of sortedEliminations) {
        events.push({
          id: `player_eliminated_${elimination.id}`,
          type: "player_eliminated",
          timestamp: elimination.eliminatedAt.toISOString(),
          ledgerSequence,
          data: {
            userId: elimination.userId,
            reason: elimination.reason,
            roundNumber: round.roundNumber,
          },
        });
      }

      // Round resolved event
      if (round.state === "RESOLVED" || round.state === "SETTLED") {
        events.push({
          id: `round_resolved_${round.id}`,
          type: "round_resolved",
          timestamp: round.updatedAt.toISOString(),
          ledgerSequence,
          data: {
            roundNumber: round.roundNumber,
            state: round.state,
            resolution: metadata.resolution,
          },
        });
      }
    }

    // Sort all events by ledger sequence, then by timestamp, then by type priority
    const typePriority: Record<string, number> = {
      arena_cancelled: 0,
      round_started: 1,
      player_eliminated: 2,
      round_resolved: 3,
      winner_declared: 4,
    };

    events.sort((a, b) => {
      if (a.ledgerSequence !== b.ledgerSequence) {
        return a.ledgerSequence - b.ledgerSequence;
      }
      if (a.timestamp !== b.timestamp) {
        return a.timestamp.localeCompare(b.timestamp);
      }
      return (typePriority[a.type] ?? 5) - (typePriority[b.type] ?? 5);
    });

    // Apply cursor-based pagination
    let startIndex = 0;
    if (cursor) {
      const cursorIndex = events.findIndex((e) => e.id === cursor);
      if (cursorIndex !== -1) {
        startIndex = cursorIndex + 1;
      }
    }

    const paginatedEvents = events.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < events.length;
    const nextCursor = hasMore ? paginatedEvents[paginatedEvents.length - 1]?.id ?? null : null;

    return {
      arenaId,
      events: paginatedEvents,
      totalEvents: events.length,
      hasMore,
      cursor: nextCursor,
    };
  }
}
