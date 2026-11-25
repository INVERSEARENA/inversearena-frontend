/**
 * GET /api/arenas/time — signed server-time synchronization for round
 * countdowns (#1401). See docs/design/server-time-sync.md.
 *
 * Kept in its own module (rather than inline in routes/arenas.ts) so it
 * has no dependency on arenaService/onChainReader, whose pre-existing
 * cross-boundary import (see services/serverTimeService.ts's own comment)
 * fails both `tsc --noEmit` and ts-jest module loading — importing this
 * file alone stays testable even while that defect exists elsewhere in
 * the router.
 */

import { Router } from "express";
import { asyncHandler } from "../middleware/validate";
import { issueSignedServerTime } from "../services/serverTimeService";

export const arenaTimeRouter = Router();

/**
 * Public/unauthenticated: it discloses only the current server time, the
 * same trust boundary as any HTTP response's Date header, and every
 * client (authenticated or not) needs it to keep a countdown accurate.
 */
arenaTimeRouter.get(
  "/time",
  asyncHandler(async (_req, res) => {
    const signed = issueSignedServerTime();
    res.json({ version: 1, ...signed });
  }),
);
