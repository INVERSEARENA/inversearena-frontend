/**
 * Seekable arena replay segments (#1692).
 *
 * Pure, side-effect-free core of the spectator timeline. Given the canonical
 * ordered event log for an arena, it produces bounded, checksummed segments of
 * public events plus the projection revision the segment ends at. It never
 * touches the network or the database; callers supply the ordered events and
 * any stored checkpoints.
 *
 * Design rules:
 *  - Seeking folds from the nearest checkpoint at or before the target, never
 *    from genesis. Checkpoints are the states after every `interval` events.
 *  - Private data is excluded by construction. `CHOICE` events (unrevealed
 *    choices) are never emitted, and `UNKNOWN` events are dropped, so a public
 *    segment cannot leak protocol-private state.
 *  - Cursors are raw event ids, so a segment whose public events are all
 *    filtered out still advances the cursor and cannot stall a client.
 *  - Clients verify each segment's checksum and link (`previousCursor`) before
 *    applying it. A mismatch means a full verified reload, not a guess.
 */

import { createHash } from "crypto";
import type { ArenaProjectionEvent } from "../services/projection/arenaEventTypes";
import {
  foldArenaProjectionEvents,
  initialArenaProjection,
  type ArenaProjectionState,
} from "../services/projection/arenaProjectionFold";

/** Schema version of the segment payload. Bump on any breaking shape change. */
export const REPLAY_SEGMENT_VERSION = 1 as const;

/** Upper bound on raw events consumed by one segment request. */
export const REPLAY_SEGMENT_MAX_EVENTS = 200;

/** Default number of raw events between stored checkpoints. */
export const REPLAY_CHECKPOINT_INTERVAL = 500;

export type PublicReplayEventType =
  | "arena_initialized"
  | "arena_configured"
  | "arena_started"
  | "arena_finished"
  | "player_joined"
  | "player_eliminated"
  | "prize_claimed"
  | "yield_received";

const PUBLIC_EVENT_TYPE_BY_TOPIC: Partial<Record<ArenaProjectionEvent["topic"], PublicReplayEventType>> = {
  INIT: "arena_initialized",
  CFGD: "arena_configured",
  START: "arena_started",
  FINISH: "arena_finished",
  JOIN: "player_joined",
  ELIM: "player_eliminated",
  CLAIMED: "prize_claimed",
  RWAYLD: "yield_received",
};

export interface PublicReplayEvent {
  /** Raw event id. Usable as a cursor. */
  cursor: string;
  type: PublicReplayEventType;
  ledgerSequence: number;
  ledgerClosedAt: string;
  txHash: string;
  /** Wallet address the event concerns, or null when none applies. */
  subject: string | null;
  /** Yield amount in stroops as a decimal string, present only for `yield_received`. */
  amountStroops: string | null;
}

/** Map one canonical event to its public form, or null when it must stay private or is not public. */
export function toPublicReplayEvent(event: ArenaProjectionEvent): PublicReplayEvent | null {
  const type = PUBLIC_EVENT_TYPE_BY_TOPIC[event.topic];
  if (!type) return null;

  let subject: string | null = null;
  let amountStroops: string | null = null;
  switch (event.topic) {
    case "JOIN":
    case "ELIM":
      subject = event.player;
      break;
    case "CLAIMED":
      subject = event.winner;
      break;
    case "RWAYLD":
      amountStroops = event.amount;
      break;
    default:
      break;
  }

  return {
    cursor: event.id,
    type,
    ledgerSequence: event.ledgerSequence,
    ledgerClosedAt: event.ledgerClosedAt,
    txHash: event.txHash,
    subject,
    amountStroops,
  };
}

/** State after folding the first `foldedCount` raw events. */
export interface ReplayCheckpoint {
  foldedCount: number;
  state: ArenaProjectionState;
}

export interface ReplaySegment {
  version: typeof REPLAY_SEGMENT_VERSION;
  arenaId: string;
  contractVersion: number | null;
  /** Cursor the client already holds; null for the first segment. */
  previousCursor: string | null;
  /** Cursor to send as `after` for the next segment. Equals `previousCursor` when nothing was consumed. */
  nextCursor: string | null;
  /** `<lastLedgerSequence>:<lastEventId>` of the projection at `nextCursor`. */
  projectionRevision: string;
  hasMore: boolean;
  events: PublicReplayEvent[];
  /** SHA-256 hex over the canonical form of every field above. */
  checksum: string;
}

export class ReplayCursorNotFoundError extends Error {
  constructor(readonly cursor: string) {
    super(`Replay cursor ${cursor} is not part of this arena's event log`);
    this.name = "ReplayCursorNotFoundError";
  }
}

export class ReplayOrderError extends Error {
  constructor(readonly eventId: string) {
    super(`Replay event ${eventId} is out of ledger order`);
    this.name = "ReplayOrderError";
  }
}

/** Fail fast on a log that is not in non-decreasing ledger order, since every later step depends on it. */
function assertLedgerOrdered(events: readonly ArenaProjectionEvent[]): void {
  for (let i = 1; i < events.length; i++) {
    if (events[i].ledgerSequence < events[i - 1].ledgerSequence) {
      throw new ReplayOrderError(events[i].id);
    }
  }
}

/**
 * Build checkpoints every `interval` raw events, starting with the empty
 * genesis state at index 0. Stored checkpoints are what make seeking cheap.
 */
export function buildReplayCheckpoints(
  arenaId: string,
  events: readonly ArenaProjectionEvent[],
  interval: number = REPLAY_CHECKPOINT_INTERVAL,
): ReplayCheckpoint[] {
  if (!Number.isInteger(interval) || interval < 1) {
    throw new RangeError("Checkpoint interval must be a positive integer");
  }
  assertLedgerOrdered(events);

  const checkpoints: ReplayCheckpoint[] = [{ foldedCount: 0, state: initialArenaProjection(arenaId) }];
  let state = checkpoints[0].state;
  events.forEach((event, index) => {
    state = foldArenaProjectionEvents(state, [event]);
    if ((index + 1) % interval === 0) {
      checkpoints.push({ foldedCount: index + 1, state });
    }
  });
  return checkpoints;
}

/**
 * Projection state after the first `foldedCount` events. Folds forward from the
 * nearest checkpoint at or before the target, so the cost is bounded by the
 * checkpoint interval rather than by the arena's full history.
 */
export function projectionAtCount(
  arenaId: string,
  events: readonly ArenaProjectionEvent[],
  foldedCount: number,
  checkpoints: readonly ReplayCheckpoint[],
): ArenaProjectionState {
  let base: ReplayCheckpoint = { foldedCount: 0, state: initialArenaProjection(arenaId) };
  for (const checkpoint of checkpoints) {
    if (checkpoint.foldedCount <= foldedCount && checkpoint.foldedCount >= base.foldedCount) {
      base = checkpoint;
    }
  }
  return foldArenaProjectionEvents(base.state, events.slice(base.foldedCount, foldedCount));
}

function projectionRevisionOf(state: ArenaProjectionState): string {
  return `${state.lastLedgerSequence ?? "none"}:${state.lastEventId ?? "none"}`;
}

/** Canonical checksum over every segment field except `checksum` itself. */
export function computeReplaySegmentChecksum(segment: Omit<ReplaySegment, "checksum">): string {
  const canonical = JSON.stringify({
    version: segment.version,
    arenaId: segment.arenaId,
    contractVersion: segment.contractVersion,
    previousCursor: segment.previousCursor,
    nextCursor: segment.nextCursor,
    projectionRevision: segment.projectionRevision,
    hasMore: segment.hasMore,
    events: segment.events,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface BuildReplaySegmentInput {
  arenaId: string;
  contractVersion: number | null;
  /** The full ordered canonical event log for the arena. */
  events: readonly ArenaProjectionEvent[];
  checkpoints: readonly ReplayCheckpoint[];
  /** The last cursor the client holds, or null to start from genesis. */
  afterCursor: string | null;
  limit?: number;
}

/**
 * Build one bounded segment starting after `afterCursor`. Consumes up to
 * `limit` raw events (clamped to REPLAY_SEGMENT_MAX_EVENTS) and returns the
 * public subset, with a checksum and the projection revision at its end.
 *
 * @throws ReplayCursorNotFoundError if `afterCursor` is not in the log.
 */
export function buildReplaySegment(input: BuildReplaySegmentInput): ReplaySegment {
  const { arenaId, contractVersion, events, checkpoints, afterCursor } = input;
  const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? REPLAY_SEGMENT_MAX_EVENTS)), REPLAY_SEGMENT_MAX_EVENTS);

  let startIndex = 0;
  if (afterCursor !== null) {
    const found = events.findIndex((event) => event.id === afterCursor);
    if (found === -1) throw new ReplayCursorNotFoundError(afterCursor);
    startIndex = found + 1;
  }

  const endIndex = Math.min(startIndex + limit, events.length);
  const consumed = events.slice(startIndex, endIndex);
  const publicEvents = consumed
    .map(toPublicReplayEvent)
    .filter((event): event is PublicReplayEvent => event !== null);

  const nextCursor = consumed.length > 0 ? consumed[consumed.length - 1].id : afterCursor;
  const projectionRevision = projectionRevisionOf(projectionAtCount(arenaId, events, endIndex, checkpoints));

  const body = {
    version: REPLAY_SEGMENT_VERSION,
    arenaId,
    contractVersion,
    previousCursor: afterCursor,
    nextCursor,
    projectionRevision,
    hasMore: endIndex < events.length,
    events: publicEvents,
  };
  return { ...body, checksum: computeReplaySegmentChecksum(body) };
}

export type ReplaySegmentIssue =
  | "format_version_mismatch"
  | "contract_version_mismatch"
  | "cursor_gap"
  | "checksum_mismatch";

export type ReplaySegmentVerification = { ok: true } | { ok: false; issue: ReplaySegmentIssue };

/**
 * Check a received segment before applying it. `lastCursor` is the cursor the
 * client has applied so far. A segment that does not link to it is a gap, and
 * the client must do a full verified reload.
 */
export function verifyReplaySegment(
  segment: ReplaySegment,
  expectation: { contractVersion: number | null; lastCursor: string | null },
): ReplaySegmentVerification {
  if (segment.version !== REPLAY_SEGMENT_VERSION) {
    return { ok: false, issue: "format_version_mismatch" };
  }
  if (segment.contractVersion !== expectation.contractVersion) {
    return { ok: false, issue: "contract_version_mismatch" };
  }
  if (segment.previousCursor !== expectation.lastCursor) {
    return { ok: false, issue: "cursor_gap" };
  }
  const { checksum, ...body } = segment;
  if (computeReplaySegmentChecksum(body) !== checksum) {
    return { ok: false, issue: "checksum_mismatch" };
  }
  return { ok: true };
}
