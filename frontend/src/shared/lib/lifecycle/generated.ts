// DO NOT EDIT. Generated from scripts/lifecycle/lifecycle-spec.json by
// scripts/lifecycle/generate-lifecycle.mjs (#1693). Change the spec and regenerate;
// `--check` fails when this file drifts from the spec.

export const ROUND_STATES = [
  "OPEN",
  "CLOSED",
  "RESOLVED",
  "SETTLED",
] as const;
export type RoundState = (typeof ROUND_STATES)[number];
export const ROUND_INITIAL_STATE: RoundState = "OPEN";
export const ROUND_TERMINAL_STATES: readonly RoundState[] = ["SETTLED"];
export const ROUND_TRANSITIONS: Readonly<Record<RoundState, readonly RoundState[]>> = {
  OPEN: ["CLOSED"],
  CLOSED: ["RESOLVED"],
  RESOLVED: ["SETTLED"],
  SETTLED: [],
};
export function isRoundState(value: string): value is RoundState {
  return (ROUND_STATES as readonly string[]).includes(value);
}
export function canTransitionRound(from: RoundState, to: RoundState): boolean {
  return ROUND_TRANSITIONS[from].includes(to);
}
export type ParsedRoundState =
  | { kind: "known"; state: RoundState }
  | { kind: "unknown"; raw: string };
export function parseRoundState(raw: string): ParsedRoundState {
  return isRoundState(raw) ? { kind: "known", state: raw } : { kind: "unknown", raw };
}

export const ARENA_GAME_STATES = [
  "Open",
  "Active",
  "Finished",
  "Cancelled",
  "Settled",
] as const;
export type ArenaGameState = (typeof ARENA_GAME_STATES)[number];
export const ARENA_GAME_INITIAL_STATE: ArenaGameState = "Open";
export const ARENA_GAME_TERMINAL_STATES: readonly ArenaGameState[] = ["Cancelled", "Settled"];
export const ARENA_GAME_TRANSITIONS: Readonly<Record<ArenaGameState, readonly ArenaGameState[]>> = {
  Open: ["Active", "Cancelled"],
  Active: ["Open", "Finished", "Cancelled"],
  Finished: ["Settled"],
  Cancelled: [],
  Settled: [],
};
export function isArenaGameState(value: string): value is ArenaGameState {
  return (ARENA_GAME_STATES as readonly string[]).includes(value);
}
export function canTransitionArenaGame(from: ArenaGameState, to: ArenaGameState): boolean {
  return ARENA_GAME_TRANSITIONS[from].includes(to);
}
export type ParsedArenaGameState =
  | { kind: "known"; state: ArenaGameState }
  | { kind: "unknown"; raw: string };
export function parseArenaGameState(raw: string): ParsedArenaGameState {
  return isArenaGameState(raw) ? { kind: "known", state: raw } : { kind: "unknown", raw };
}

export const TRANSACTION_STATES = [
  "submitted",
  "confirmed",
  "failed",
  "dead",
  "unknown",
] as const;
export type TransactionState = (typeof TRANSACTION_STATES)[number];
export const TRANSACTION_INITIAL_STATE: TransactionState = "submitted";
export const TRANSACTION_TERMINAL_STATES: readonly TransactionState[] = ["confirmed", "dead"];
export const TRANSACTION_TRANSITIONS: Readonly<Record<TransactionState, readonly TransactionState[]>> = {
  submitted: ["confirmed", "failed", "dead", "unknown"],
  confirmed: [],
  failed: ["dead"],
  dead: [],
  unknown: ["confirmed", "failed", "dead"],
};
export function isTransactionState(value: string): value is TransactionState {
  return (TRANSACTION_STATES as readonly string[]).includes(value);
}
export function canTransitionTransaction(from: TransactionState, to: TransactionState): boolean {
  return TRANSACTION_TRANSITIONS[from].includes(to);
}
export type ParsedTransactionState =
  | { kind: "known"; state: TransactionState }
  | { kind: "unknown"; raw: string };
export function parseTransactionState(raw: string): ParsedTransactionState {
  return isTransactionState(raw) ? { kind: "known", state: raw } : { kind: "unknown", raw };
}
