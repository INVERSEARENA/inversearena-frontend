/**
 * Active Stake Limits Service (#1411)
 *
 * Design note
 * -----------
 * Ownership  : This service owns the single, authoritative check for whether a
 *              player is allowed to join (or remain in) another arena given their
 *              current aggregate active exposure.
 *
 * State model: A player's active stake is the sum of confirmed + pending stakes
 *              across rounds whose state is OPEN or CLOSED (i.e. the round has
 *              not yet resolved and the stake has not been returned).  We use
 *              BOTH states because a CLOSED round may still roll back to OPEN on
 *              a transient failure, so counting only OPEN rounds would allow a
 *              brief over-limit window.
 *
 * Failure     : If the DB query fails the check is treated as BLOCKED (safe
 *              default) to prevent a partial failure from bypassing the limit.
 *              Callers can catch `ActiveStakeLimitError` specifically to surface
 *              a clean 409 to the client.
 *
 * Compatibility: No existing REST surface is changed.  The route handler calls
 *               `assertBelowActiveStakeLimit` before recording a join.
 */

import type { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger";
import { activeStakeLimitBlockedTotal, activeStakeCurrentGauge } from "../utils/metrics";

// ── Configuration ────────────────────────────────────────────────────────────

/** Maximum aggregate stake (in USDC-equivalent units) a single player may have
 *  locked in active rounds at any one time. Override via env in tests. */
export const MAX_ACTIVE_STAKE_USDC =
  Number(process.env.MAX_ACTIVE_STAKE_USDC ?? "10000");

// ── Errors ───────────────────────────────────────────────────────────────────

export class ActiveStakeLimitError extends Error {
  readonly status = 409;
  readonly code = "ACTIVE_STAKE_LIMIT_EXCEEDED";

  constructor(
    readonly userId: string,
    readonly currentStake: number,
    readonly incomingStake: number,
    readonly limit: number,
  ) {
    super(
      `Active stake limit exceeded. Current: ${currentStake}, incoming: ${incomingStake}, ` +
        `limit: ${limit}. Resolve or wait for active arenas before joining a new one.`,
    );
    this.name = "ActiveStakeLimitError";
  }
}

// ── Service ──────────────────────────────────────────────────────────────────

export class ActiveStakeLimitsService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Returns the user's current aggregate active stake (confirmed + pending)
   * across all rounds that are OPEN or CLOSED.
   */
  async getActiveStake(userId: string): Promise<number> {
    // Sum the stake field from playerChoices JSONB for rounds in active states.
    // We use a raw query here because Prisma does not support JSONB array
    // unnesting in its query builder (#1411).
    type Row = { total: string };
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT COALESCE(SUM((choice->>'stake')::numeric), 0)::text AS total
      FROM   rounds r
      CROSS  JOIN LATERAL jsonb_array_elements(r.metadata->'playerChoices') AS c(choice)
      WHERE  r.state IN ('OPEN', 'CLOSED')
        AND  choice->>'userId' = ${userId}
    `;
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * Throws `ActiveStakeLimitError` if adding `incomingStake` to the player's
   * confirmed + pending exposure would breach `MAX_ACTIVE_STAKE_USDC`.
   *
   * This is the single enforced gate — call it in every join path.
   */
  async assertBelowActiveStakeLimit(
    userId: string,
    incomingStake: number,
    limit = MAX_ACTIVE_STAKE_USDC,
  ): Promise<void> {
    let current: number;
    try {
      current = await this.getActiveStake(userId);
    } catch (err) {
      // Treat a DB failure as blocked (safe default) to avoid bypassing the limit.
      logger.error({ err, userId }, "active_stake_limit_check_failed — blocking join");
      activeStakeLimitBlockedTotal.inc({ reason: "db_error" });
      throw new ActiveStakeLimitError(userId, 0, incomingStake, limit);
    }

    // Publish current gauge for observability.
    activeStakeCurrentGauge.set({ user_id: userId }, current);

    if (current + incomingStake > limit) {
      logger.warn(
        { userId, current, incomingStake, limit },
        "active_stake_limit_blocked",
      );
      activeStakeLimitBlockedTotal.inc({ reason: "limit_exceeded" });
      throw new ActiveStakeLimitError(userId, current, incomingStake, limit);
    }
  }
}
