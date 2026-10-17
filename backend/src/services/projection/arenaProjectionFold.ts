/**
 * Canonical arena projection fold (#1382).
 *
 * This is the single, deterministic, side-effect-free core of the
 * checkpointed projection: given a projection state and one on-chain event,
 * produce the next projection state. It is the one enforced implementation
 * of "what does an arena's projected state look like" — every caller
 * (genesis replay, checkpoint-resumed replay, tests) must go through this
 * function rather than re-deriving arena state ad hoc.
 *
 * Determinism contract:
 *  - `fold(fold(fold(initialProjection(id), e1), e2), e3)` (genesis replay)
 *    MUST equal `fold(fold(checkpointedStateAfter(e1, e2)), e3)`
 *    (checkpoint-resumed replay), for any prefix split. This is verified by
 *    the genesis-vs-checkpoint equivalence test in
 *    `arenaProjectionEquivalence.unit.test.ts`.
 *  - Folding the same event id twice is a no-op (idempotent — handles
 *    duplicate delivery from at-least-once event sources).
 *  - Folding never throws. A malformed/unknown event is recorded in
 *    `skippedEventIds` and otherwise leaves the projection state
 *    untouched, so replay can always proceed.
 */

import type { ArenaProjectionEvent } from "./arenaEventTypes";

export type ArenaProjectionGameState =
  | "unknown"
  | "open"
  | "in_progress"
  | "finished"
  | "cancelled";

export interface ArenaProjectionState {
  arenaId: string;
  /** Highest ledger sequence folded into this projection so far, or null pre-genesis. */
  lastLedgerSequence: number | null;
  /** Event id of the last successfully-applied (non-skipped) event, for diagnostics. */
  lastEventId: string | null;
  gameState: ArenaProjectionGameState;
  admin: string | null;
  /** Wallet addresses that have joined, in first-seen order. */
  players: string[];
  /** Wallet addresses that have submitted a choice in the current round, in first-seen order. */
  choicesSubmitted: string[];
  /** Wallet addresses eliminated so far, in elimination order. */
  eliminated: string[];
  winner: string | null;
  prizeClaimed: boolean;
  /** Cumulative RWA yield received, in stroops, as a decimal string to avoid float precision loss. */
  totalYieldStroops: string;
  /**
   * Event ids already folded, used to make folding idempotent under
   * duplicate delivery. Bounded by the number of events in the arena's
   * lifetime, which is small (join/choice/elim per player per round) —
   * acceptable to keep in the snapshot; see the design note for the
   * tradeoff against a separate dedupe table.
   */
  appliedEventIds: string[];
  /** Event ids that were folded but could not be interpreted (unknown topic / malformed payload). */
  skippedEventIds: string[];
}

/** The projection state for an arena that has not observed any events yet. */
export function initialArenaProjection(arenaId: string): ArenaProjectionState {
  return {
    arenaId,
    lastLedgerSequence: null,
    lastEventId: null,
    gameState: "unknown",
    admin: null,
    players: [],
    choicesSubmitted: [],
    eliminated: [],
    winner: null,
    prizeClaimed: false,
    totalYieldStroops: "0",
    appliedEventIds: [],
    skippedEventIds: [],
  };
}

function addStroops(a: string, b: string): string {
  // bigint arithmetic — avoids float precision loss on large stroop amounts.
  return (BigInt(a) + BigInt(b)).toString();
}

function appendUnique(list: string[], value: string): string[] {
  return list.includes(value) ? list : [...list, value];
}

/**
 * Fold a single on-chain event into a projection state, returning the next
 * state. Never mutates `state`; always returns a new object (or the same
 * reference only for the pure no-op duplicate/out-of-order-skip paths,
 * which is safe because callers treat the return value as the new state).
 */
export function foldArenaProjectionEvent(
  state: ArenaProjectionState,
  event: ArenaProjectionEvent,
): ArenaProjectionState {
  // Idempotency: an event id we've already applied OR already skipped is a
  // no-op. This makes the fold safe under duplicate delivery (#1382 edge
  // case) without requiring the caller to pre-dedupe.
  if (state.appliedEventIds.includes(event.id) || state.skippedEventIds.includes(event.id)) {
    return state;
  }

  // Stale/out-of-order guard: an event whose ledger is behind what we've
  // already folded cannot be genesis-equivalent to fold in place (it would
  // make replay order-dependent). Treat it as a skip rather than silently
  // reordering history.
  if (state.lastLedgerSequence !== null && event.ledgerSequence < state.lastLedgerSequence) {
    return {
      ...state,
      skippedEventIds: [...state.skippedEventIds, event.id],
    };
  }

  const advanced: ArenaProjectionState = {
    ...state,
    lastLedgerSequence: event.ledgerSequence,
  };

  switch (event.topic) {
    case "INIT":
      return {
        ...advanced,
        gameState: "open",
        admin: event.admin,
        lastEventId: event.id,
        appliedEventIds: [...advanced.appliedEventIds, event.id],
      };

    case "CFGD":
      // Configuration changes don't alter projected game/player state —
      // recorded as applied so it counts toward lastEventId/replay position.
      return {
        ...advanced,
        lastEventId: event.id,
        appliedEventIds: [...advanced.appliedEventIds, event.id],
      };

    case "START":
      return {
        ...advanced,
        gameState: "in_progress",
        lastEventId: event.id,
        appliedEventIds: [...advanced.appliedEventIds, event.id],
      };

    case "FINISH":
      return {
        ...advanced,
        gameState: "finished",
        lastEventId: event.id,
        appliedEventIds: [...advanced.appliedEventIds, event.id],
      };

    case "JOIN":
      return {
        ...advanced,
        players: appendUnique(advanced.players, event.player),
        lastEventId: event.id,
        appliedEventIds: [...advanced.appliedEventIds, event.id],
      };

    case "CHOICE":
      return {
        ...advanced,
        choicesSubmitted: appendUnique(advanced.choicesSubmitted, event.player),
        lastEventId: event.id,
        appliedEventIds: [...advanced.appliedEventIds, event.id],
      };

    case "ELIM":
      return {
        ...advanced,
        eliminated: appendUnique(advanced.eliminated, event.player),
        // A new round's choices reset once eliminations from the previous
        // round land; the contract clears choices after resolve_round (see
        // docs/smart-contract-architecture.md). Only clear entries for
        // players who are not the one just eliminated is unnecessary — the
        // contract-level "choices cleared for next round" applies to all
        // survivors too, so the projection clears the whole set.
        choicesSubmitted: [],
        lastEventId: event.id,
        appliedEventIds: [...advanced.appliedEventIds, event.id],
      };

    case "CLAIMED":
      return {
        ...advanced,
        winner: event.winner,
        prizeClaimed: true,
        lastEventId: event.id,
        appliedEventIds: [...advanced.appliedEventIds, event.id],
      };

    case "RWAYLD":
      return {
        ...advanced,
        totalYieldStroops: addStroops(advanced.totalYieldStroops, event.amount),
        lastEventId: event.id,
        appliedEventIds: [...advanced.appliedEventIds, event.id],
      };

    case "UNKNOWN":
    default:
      // Malformed/unrecognized event: record the skip and advance the
      // ledger watermark (so replay does not get stuck retrying it forever)
      // without touching interpreted state.
      return {
        ...advanced,
        skippedEventIds: [...advanced.skippedEventIds, event.id],
      };
  }
}

/** Fold an ordered list of events into a projection state, starting from `state`. */
export function foldArenaProjectionEvents(
  state: ArenaProjectionState,
  events: readonly ArenaProjectionEvent[],
): ArenaProjectionState {
  return events.reduce(foldArenaProjectionEvent, state);
}
