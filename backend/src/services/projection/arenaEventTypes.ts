/**
 * Canonical on-chain arena event types (#1382).
 *
 * Mirrors the topics documented in `docs/event-schema.md`, which is the
 * authoritative description of what the ArenaContract emits via
 * `env.events().publish((topic,), data)`. This module is the single typed
 * boundary between raw Soroban RPC event payloads and the projection fold —
 * nothing downstream of `toArenaProjectionEvent` should touch `xdr.ScVal` or
 * Soroban RPC response shapes directly.
 */

/** Topic symbols exactly as emitted by the contract (see docs/event-schema.md). */
export const ARENA_EVENT_TOPICS = [
  "INIT",
  "CFGD",
  "START",
  "FINISH",
  "JOIN",
  "CHOICE",
  "ELIM",
  "CLAIMED",
  "RWAYLD",
] as const;

export type ArenaEventTopic = (typeof ARENA_EVENT_TOPICS)[number];

export function isArenaEventTopic(value: string): value is ArenaEventTopic {
  return (ARENA_EVENT_TOPICS as readonly string[]).includes(value);
}

interface BaseArenaEvent {
  /**
   * Stable identifier for this event, as assigned by the RPC server
   * (`EventResponse.id`, unique per ledger+event index). This is the key
   * used for duplicate-delivery detection in the fold function — it must
   * never be derived from mutable fields.
   */
  id: string;
  contractId: string;
  ledgerSequence: number;
  ledgerClosedAt: string;
  txHash: string;
}

export interface ArenaInitEvent extends BaseArenaEvent {
  topic: "INIT";
  admin: string;
}

export interface ArenaConfiguredEvent extends BaseArenaEvent {
  topic: "CFGD";
}

export interface ArenaStartedEvent extends BaseArenaEvent {
  topic: "START";
}

export interface ArenaFinishedEvent extends BaseArenaEvent {
  topic: "FINISH";
}

export interface ArenaPlayerJoinedEvent extends BaseArenaEvent {
  topic: "JOIN";
  player: string;
}

export interface ArenaChoiceSubmittedEvent extends BaseArenaEvent {
  topic: "CHOICE";
  player: string;
}

export interface ArenaPlayerEliminatedEvent extends BaseArenaEvent {
  topic: "ELIM";
  player: string;
}

export interface ArenaPrizeClaimedEvent extends BaseArenaEvent {
  topic: "CLAIMED";
  winner: string;
}

export interface ArenaRwaYieldEvent extends BaseArenaEvent {
  topic: "RWAYLD";
  /** Yield amount in stroops (1 XLM = 10^7 stroops), per docs/event-schema.md. */
  amount: string;
}

/**
 * A malformed/unrecognized event that could not be decoded into one of the
 * known topics above. Folding this must not throw — it must be recorded as
 * a skip so replay can proceed and the failure is observable (see the
 * design note's "failure behavior" section).
 */
export interface ArenaUnknownEvent extends BaseArenaEvent {
  topic: "UNKNOWN";
  rawTopic: string | null;
  reason: string;
}

export type ArenaProjectionEvent =
  | ArenaInitEvent
  | ArenaConfiguredEvent
  | ArenaStartedEvent
  | ArenaFinishedEvent
  | ArenaPlayerJoinedEvent
  | ArenaChoiceSubmittedEvent
  | ArenaPlayerEliminatedEvent
  | ArenaPrizeClaimedEvent
  | ArenaRwaYieldEvent
  | ArenaUnknownEvent;
