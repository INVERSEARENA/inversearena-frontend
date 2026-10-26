"use client";

/**
 * useArenaReducer — explicit phase-driven state machine for the arena page (#1605).
 *
 * Replaces many interdependent useState calls with a single typed reducer whose
 * transitions are exhaustive and testable.  The machine phase is always derived
 * from chain-authoritative data (playerStatus, snapshot) — the UI cannot enter
 * a state that chain data contradicts.
 *
 * Phase lifecycle:
 *   idle → committing → committed → revealing → revealed → resolved → winner | eliminated
 *
 * Overlays and button visibility are derived from machine state only.
 */

import { useReducer, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────────────────

export type ArenaPhase =
  | "idle"
  | "committing"
  | "committed"
  | "revealing"
  | "revealed"
  | "resolved"
  | "winner"
  | "eliminated";

export type RoundPhase = "commit" | "reveal";

export interface ArenaState {
  /** Current machine phase. */
  phase: ArenaPhase;
  /** Commit-reveal timer phase within a round. */
  roundPhase: RoundPhase;
  /** Currently selected heads/tails choice. */
  selectedChoice: "heads" | "tails" | null;
  /** Whether the player has joined the arena. */
  isJoined: boolean;
  /** Whether a winning claim is available. */
  hasWon: boolean;
  /** Whether the payout claim is backend-ready. */
  claimReady: boolean;
  /** Current round number. */
  currentRound: number;
  /** Survivor count and total capacity. */
  survivors: { current: number; max: number };
  /** Loading flags. */
  isLoadingArena: boolean;
  /** Whether the commit time window expired without a commit. */
  commitTimeExpired: boolean;
  /** Whether the current round has been resolved on-chain. */
  isRoundResolved: boolean;
  /** Whether the player committed a choice this round. */
  hasCommittedForRound: boolean;
  /** Whether to show the elimination summary overlay. */
  showEliminationSummary: boolean;
  /** Signing policy rejection notice. */
  policyNotice: string | null;
  /** Live player stats from chain/API. */
  currentStake: number;
  potentialPayout: number;
  entryFee: number | null;
  playerCount: number | null;
  userStatus: string;
}

// ── Actions ───────────────────────────────────────────────────────────────

export type ArenaAction =
  | { type: "SELECT_CHOICE"; choice: "heads" | "tails" }
  | { type: "BEGIN_COMMIT" }
  | { type: "COMMIT_CONFIRMED" }
  | { type: "COMMIT_TIME_EXPIRED" }
  | { type: "BEGIN_REVEAL" }
  | { type: "REVEAL_CONFIRMED" }
  | { type: "ROUND_RESOLVED"; roundNumber: number }
  | { type: "ROUND_ADVANCED"; roundNumber: number }
  | { type: "WINNER_DECLARED" }
  | { type: "ELIMINATED" }
  | { type: "CHAIN_STATE_LOADED"; payload: ChainStatePayload }
  | { type: "LOADING_ARENA"; loading: boolean }
  | { type: "SET_COMMITTED_FOR_ROUND"; committed: boolean }
  | { type: "SET_CLAIM_READY"; ready: boolean }
  | { type: "SET_POLICY_NOTICE"; notice: string | null }
  | { type: "SHOW_ELIMINATION_SUMMARY"; show: boolean }
  | { type: "RESET_ROUND" };

export interface ChainStatePayload {
  isUserIn: boolean;
  hasWon: boolean;
  survivorsCount: number;
  maxCapacity: number;
  currentStake: number;
  potentialPayout: number;
  entryFee: number;
  playerCount: number;
  currentRound: number;
}

// ── Initial state ─────────────────────────────────────────────────────────

export const initialArenaState: ArenaState = {
  phase: "idle",
  roundPhase: "commit",
  selectedChoice: null,
  isJoined: false,
  hasWon: false,
  claimReady: false,
  currentRound: 1,
  survivors: { current: 128, max: 1024 },
  isLoadingArena: false,
  commitTimeExpired: false,
  isRoundResolved: false,
  hasCommittedForRound: false,
  showEliminationSummary: false,
  policyNotice: null,
  currentStake: 1200,
  potentialPayout: 24420,
  entryFee: null,
  playerCount: null,
  userStatus: "STILL IN",
};

// ── Allowed transitions ───────────────────────────────────────────────────

/** Returns true when the transition is valid given the current phase. */
function canTransition(from: ArenaPhase, to: ArenaPhase): boolean {
  const allowed: Record<ArenaPhase, ArenaPhase[]> = {
    idle:       ["committing"],
    committing: ["committed", "idle"],
    committed:  ["revealing", "idle"],
    revealing:  ["revealed", "committed"],
    revealed:   ["resolved", "committed"],
    resolved:   ["winner", "eliminated", "idle"],
    winner:     ["idle"],
    eliminated: ["idle"],
  };
  return (allowed[from] ?? []).includes(to);
}

// ── Reducer ───────────────────────────────────────────────────────────────

export function arenaReducer(state: ArenaState, action: ArenaAction): ArenaState {
  switch (action.type) {
    case "SELECT_CHOICE":
      // Only update choice during commit phase; ignore if committed.
      if (state.phase === "committed" || state.roundPhase !== "commit") return state;
      return { ...state, selectedChoice: action.choice };

    case "BEGIN_COMMIT":
      if (!canTransition(state.phase, "committing")) return state;
      return { ...state, phase: "committing" };

    case "COMMIT_CONFIRMED":
      if (!canTransition(state.phase, "committed")) return state;
      return { ...state, phase: "committed", hasCommittedForRound: true };

    case "COMMIT_TIME_EXPIRED":
      return {
        ...state,
        commitTimeExpired: true,
        roundPhase: "reveal",
        // If never committed, return to idle so the UI shows "time expired" not a commit button.
        phase: state.hasCommittedForRound ? "committed" : "idle",
      };

    case "BEGIN_REVEAL":
      if (!canTransition(state.phase, "revealing")) return state;
      return { ...state, phase: "revealing", roundPhase: "reveal" };

    case "REVEAL_CONFIRMED":
      if (!canTransition(state.phase, "revealed")) return state;
      return { ...state, phase: "revealed", hasCommittedForRound: false };

    case "ROUND_RESOLVED":
      if (!canTransition(state.phase, "resolved")) return state;
      return { ...state, phase: "resolved", isRoundResolved: true };

    case "WINNER_DECLARED":
      return {
        ...state,
        phase: "winner",
        hasWon: true,
        userStatus: "WINNER!",
        isRoundResolved: false,
        showEliminationSummary: true,
      };

    case "ELIMINATED":
      return {
        ...state,
        phase: "eliminated",
        userStatus: "ELIMINATED",
        showEliminationSummary: true,
      };

    case "ROUND_ADVANCED":
      return {
        ...state,
        phase: "idle",
        roundPhase: "commit",
        currentRound: action.roundNumber,
        selectedChoice: null,
        commitTimeExpired: false,
        isRoundResolved: false,
        hasCommittedForRound: false,
      };

    case "RESET_ROUND":
      return {
        ...state,
        phase: "idle",
        roundPhase: "commit",
        selectedChoice: null,
        commitTimeExpired: false,
        isRoundResolved: false,
      };

    case "CHAIN_STATE_LOADED": {
      const p = action.payload;
      const hasWon = p.hasWon;
      return {
        ...state,
        isJoined: p.isUserIn,
        hasWon,
        survivors: { current: p.survivorsCount, max: p.maxCapacity },
        currentStake: p.currentStake,
        potentialPayout: p.potentialPayout,
        entryFee: p.entryFee,
        playerCount: p.playerCount,
        currentRound: p.currentRound,
        userStatus: hasWon ? "WINNER!" : "STILL IN",
        // Move to winner phase if chain says so and we're not already there.
        phase: hasWon && state.phase !== "winner" ? "winner" : state.phase,
        showEliminationSummary: hasWon && state.phase !== "winner"
          ? true
          : state.showEliminationSummary,
      };
    }

    case "LOADING_ARENA":
      return { ...state, isLoadingArena: action.loading };

    case "SET_COMMITTED_FOR_ROUND":
      return { ...state, hasCommittedForRound: action.committed };

    case "SET_CLAIM_READY":
      return { ...state, claimReady: action.ready };

    case "SET_POLICY_NOTICE":
      return { ...state, policyNotice: action.notice };

    case "SHOW_ELIMINATION_SUMMARY":
      return { ...state, showEliminationSummary: action.show };

    default:
      return state;
  }
}

// ── Derived selectors ─────────────────────────────────────────────────────

/** Whether the commit button should be shown. */
export function canShowCommitButton(state: ArenaState): boolean {
  return (
    state.selectedChoice !== null &&
    state.phase === "idle" &&
    state.roundPhase === "commit" &&
    !state.commitTimeExpired
  );
}

/** Whether the reveal button should be shown. */
export function canShowRevealButton(state: ArenaState): boolean {
  return state.phase === "committed" && state.hasCommittedForRound;
}

/** Whether the claim button should be shown. */
export function canShowClaimButton(state: ArenaState): boolean {
  return (state.phase === "winner" || state.hasWon) && state.claimReady;
}

// ── Hook ─────────────────────────────────────────────────────────────────

export interface UseArenaReducerResult {
  state: ArenaState;
  dispatch: React.Dispatch<ArenaAction>;
  canShowCommitButton: boolean;
  canShowRevealButton: boolean;
  canShowClaimButton: boolean;
}

export function useArenaReducer(): UseArenaReducerResult {
  const [state, dispatch] = useReducer(arenaReducer, initialArenaState);

  return {
    state,
    dispatch,
    canShowCommitButton: canShowCommitButton(state),
    canShowRevealButton: canShowRevealButton(state),
    canShowClaimButton: canShowClaimButton(state),
  };
}
