/**
 * Signed server-time synchronization for round countdowns (#1401). See
 * docs/design/server-time-sync.md.
 *
 * A client-side countdown timer (frontend/src/shared-d/hooks/useArenaTimer.ts)
 * has no trustworthy source of "now": its own clock can be wrong (skew),
 * paused (device sleep), or briefly disconnected (reconnect). Its existing
 * `sync(serverSeconds)` method takes a raw number with no origin proof, so
 * a wrong or malicious value is indistinguishable from a legitimate one.
 * This service signs the server's current time with the existing JWT
 * keyring (config/secretKeyring.ts) so a client can verify the value
 * actually came from this server and was issued recently, rather than
 * trusting an arbitrary number.
 */

import jwt from "jsonwebtoken";
import { getKeyring, recordVerification, verificationCandidates } from "../config/secretKeyring";
import { logger } from "../utils/logger";
import { serverTimeIssuedTotal, serverTimeVerifiedTotal } from "../utils/metrics";

export interface SignedServerTime {
  /** Server's current time, epoch milliseconds. */
  serverTimeMs: number;
  /** Same instant, ISO-8601, for human-readable logging/debugging. */
  issuedAt: string;
  /** Compact JWT encoding { serverTimeMs, iat }, signed by the current JWT key. */
  token: string;
}

export class ServerTimeUnavailableError extends Error {
  constructor() {
    super("Server time signing is not configured.");
    this.name = "ServerTimeUnavailableError";
  }
}

/**
 * Issues a freshly signed server-time token. Thin by design — this exists
 * so `arenas.ts`'s GET /arenas/time handler stays a one-line delegation
 * and so the signing logic is independently unit-testable without an
 * Express app.
 */
export function issueSignedServerTime(now: number = Date.now()): SignedServerTime {
  const keyring = getKeyring("jwt");
  if (!keyring) {
    throw new ServerTimeUnavailableError();
  }

  const token = jwt.sign({ serverTimeMs: now }, keyring.current.secret, {
    keyid: keyring.current.kid,
    expiresIn: "5m",
  });

  serverTimeIssuedTotal.inc();
  return { serverTimeMs: now, issuedAt: new Date(now).toISOString(), token };
}

export type ServerTimeVerification =
  | { ok: true; serverTimeMs: number }
  | { ok: false; reason: "unknown_kid" | "bad_signature" | "expired" | "malformed" };

/**
 * Verifies a previously issued token, honoring the same current/previous
 * rotation overlap every other JWT verification in this codebase does
 * (verificationCandidates), so a server-time token issued just before a
 * key rotation does not suddenly become unverifiable mid-round.
 */
export function verifySignedServerTime(token: string): ServerTimeVerification {
  const keyring = getKeyring("jwt");
  if (!keyring) {
    return { ok: false, reason: "malformed" };
  }

  const decoded = jwt.decode(token, { complete: true });
  const kid = typeof decoded?.header.kid === "string" ? decoded.header.kid : undefined;
  const candidates = verificationCandidates(keyring, kid);

  if (candidates.length === 0) {
    recordVerification("jwt", "unknown_kid", "none", kid);
    return { ok: false, reason: "unknown_kid" };
  }

  for (const key of candidates) {
    try {
      const payload = jwt.verify(token, key.secret) as { serverTimeMs?: unknown };
      if (typeof payload.serverTimeMs !== "number") {
        return { ok: false, reason: "malformed" };
      }
      recordVerification("jwt", "accepted", key.slot, kid);
      serverTimeVerifiedTotal.inc({ outcome: "accepted" });
      return { ok: true, serverTimeMs: payload.serverTimeMs };
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        serverTimeVerifiedTotal.inc({ outcome: "expired" });
        return { ok: false, reason: "expired" };
      }
      // Try the next candidate key (rotation overlap) before giving up.
    }
  }

  recordVerification("jwt", "bad_signature", "none", kid);
  serverTimeVerifiedTotal.inc({ outcome: "bad_signature" });
  logger.warn({ event: "server_time_verification_failed", kid }, "server-time token failed verification");
  return { ok: false, reason: "bad_signature" };
}
