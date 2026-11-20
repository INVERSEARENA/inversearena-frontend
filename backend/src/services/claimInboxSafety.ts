import type {
  ClaimInboxRefundCandidate,
  ClaimInboxRefundSource,
  ClaimInboxVerifier,
} from "./claimInboxService";
import type { ClaimInboxArenaState } from "../types/claimInbox";
import { claimInboxVerificationFailures } from "../utils/metrics";
import { logger } from "../utils/logger";

/** Isolate a refund-source outage so payout positions remain available. */
export async function loadRefundsSafely(
  findRefunds: ClaimInboxRefundSource,
  walletAddress: string,
): Promise<ClaimInboxRefundCandidate[]> {
  try {
    return await findRefunds(walletAddress);
  } catch (error) {
    logger.error(
      {
        subsystem: "claim-inbox",
        stage: "refund_source",
        error: error instanceof Error ? error.message : "unknown",
      },
      "Cancellation recovery unavailable; serving payout records only",
    );
    return [];
  }
}

/** Bound chain verification and represent failures as unavailable positions. */
export async function verifyArenasSafely(
  verifyArenas: ClaimInboxVerifier,
  arenaIds: string[],
  budgetMs: number,
): Promise<{ states: Map<string, ClaimInboxArenaState>; failedArenas: Set<string>; failed: number }> {
  const states = new Map<string, ClaimInboxArenaState>();
  const failedArenas = new Set<string>();
  if (arenaIds.length === 0) return { states, failedArenas, failed: 0 };

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("claim_inbox_verification_timeout")), budgetMs);
  });

  try {
    const found = await Promise.race([verifyArenas(arenaIds), deadline]);
    for (const [arenaId, state] of found) states.set(arenaId, state);
    for (const arenaId of arenaIds) if (!states.has(arenaId)) failedArenas.add(arenaId);
    if (failedArenas.size > 0) {
      claimInboxVerificationFailures.inc({ reason: "partial" }, failedArenas.size);
      logger.warn(
        { subsystem: "claim-inbox", stage: "verify", failedArenas: failedArenas.size, requested: arenaIds.length },
        "Some arena reads failed; affected positions report unavailable",
      );
    }
    return { states, failedArenas, failed: failedArenas.size };
  } catch (error) {
    for (const arenaId of arenaIds) if (!states.has(arenaId)) failedArenas.add(arenaId);
    const reason = error instanceof Error && error.message.includes("timeout") ? "timeout" : "error";
    claimInboxVerificationFailures.inc({ reason }, failedArenas.size);
    logger.warn(
      {
        subsystem: "claim-inbox",
        stage: "verify",
        error: error instanceof Error ? error.message : "unknown",
        failedArenas: failedArenas.size,
      },
      "On-chain verification incomplete; affected positions report unavailable",
    );
    return { states, failedArenas, failed: failedArenas.size };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
