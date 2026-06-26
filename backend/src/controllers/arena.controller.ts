import type { Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

// ── Query param validation ──────────────────────────────────────────
const ParticipantsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

// ── Response shape ──────────────────────────────────────────────────
export interface Participant {
  walletAddress: string;
  status: "active" | "eliminated";
  joinedAt: string;
}

interface DecodedCursor {
  offset: number;
}

// ── Controller ──────────────────────────────────────────────────────
export class ArenaController {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * GET /api/arenas/:id/participants
   *
   * Returns paginated list of participants in a specific arena.
   *
   * Query params:
   *  - limit  (1–100, default 25)
   *  - cursor (opaque base64 string for pagination, omit for first page)
   *
   * Response:
   *  {
   *    items: Participant[],
   *    cursor: string | null,
   *    hasMore: boolean
   *  }
   */
  getParticipants = async (req: Request, res: Response): Promise<void> => {
    const arenaId = req.params.id;
    if (!arenaId) {
      res.status(400).json({ error: "Arena ID is required" });
      return;
    }
    const { limit, cursor } = ParticipantsQuerySchema.parse(req.query);

    // Verify arena exists
    const arena = await this.prisma.arena.findUnique({
      where: { id: arenaId },
    });

    if (!arena) {
      res.status(404).json({ error: `Arena with ID ${arenaId} not found` });
      return;
    }

    const offset = cursor ? this.decodeCursor(cursor) : 0;

    // Build the full participant list
    const participants = await this.buildParticipantList(arenaId);

    // Paginate
    const page = participants.slice(offset, offset + limit);
    const hasMore = offset + limit < participants.length;
    const nextCursor = hasMore ? this.encodeCursor(offset + limit) : null;

    res.json({
      items: page,
      cursor: nextCursor,
      hasMore,
    });
  };

  // ──────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────

  /**
   * Builds a list of all participants in an arena by examining the first round's
   * player choices. Determines status (active/eliminated) by checking elimination logs.
   *
   * Returns participants sorted by joinedAt (earliest first).
   */
  private async buildParticipantList(arenaId: string): Promise<Participant[]> {
    // Fetch all rounds for this arena
    const rounds = await this.prisma.round.findMany({
      where: { arenaId },
      orderBy: { roundNumber: "asc" },
      include: {
        eliminationLogs: {
          include: {
            user: true,
          },
        },
      },
    });

    if (rounds.length === 0) {
      return [];
    }

    // Extract participants from the first round's metadata
    const firstRound = rounds[0]!;
    const metadata = (firstRound.metadata as Record<string, unknown>) || {};
    const playerChoices = (metadata.playerChoices as Array<{ userId: string; stake?: number }>) || [];

    if (playerChoices.length === 0) {
      return [];
    }

    // Get all user IDs who participated
    const userIds = playerChoices.map((p) => p.userId);

    // Fetch user details
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, walletAddress: true, createdAt: true },
    });

    const userMap = new Map(users.map((u) => [u.id, u]));

    // Collect all eliminated user IDs across all rounds
    const eliminatedUserIds = new Set<string>();
    rounds.forEach((round) => {
      round.eliminationLogs.forEach((log) => {
        eliminatedUserIds.add(log.userId);
      });
    });

    // Build participant list
    const participants: Participant[] = playerChoices
      .map((choice) => {
        const user = userMap.get(choice.userId);
        if (!user) return null;

        return {
          walletAddress: user.walletAddress,
          status: eliminatedUserIds.has(user.id) ? ("eliminated" as const) : ("active" as const),
          joinedAt: user.createdAt.toISOString(),
        };
      })
      .filter((p): p is Participant => p !== null);

    // Sort by joinedAt (earliest first)
    participants.sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime());

    return participants;
  }

  // ── Cursor encoding ───────────────────────────────────────────────

  private encodeCursor(offset: number): string {
    const payload: DecodedCursor = { offset };
    return Buffer.from(JSON.stringify(payload)).toString("base64url");
  }

  private decodeCursor(cursor: string): number {
    try {
      const payload = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf-8"),
      ) as DecodedCursor;

      if (typeof payload.offset !== "number" || payload.offset < 0) {
        return 0;
      }
      return payload.offset;
    } catch {
      return 0;
    }
  }
}
