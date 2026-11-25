/**
 * Spectator timeline state machine (#1692).
 *
 * A pure reducer for the read-only replay timeline: play, pause, step, seek,
 * change speed, and return to live. It only moves a cursor over already-verified
 * events. It never mutates wallet or game state, and live SSE remains the
 * authority for current state. The UI owns the timer and calls `tick` on it.
 */

export const TIMELINE_SPEEDS = [0.5, 1, 2, 4] as const;
export type TimelineSpeed = (typeof TIMELINE_SPEEDS)[number];

export type TimelineMode = "live" | "replay";

export type TimelineStatus = "ready" | "unavailable";

export interface SpectatorTimelineState {
  mode: TimelineMode;
  status: TimelineStatus;
  playing: boolean;
  speed: TimelineSpeed;
  /** Index of the event whose projected state is shown. */
  cursor: number;
  /** Number of verified events loaded. */
  length: number;
  /** Set only while `status` is `unavailable`. */
  unavailableReason: string | null;
}

export type SpectatorTimelineAction =
  | { type: "loaded"; length: number }
  | { type: "play" }
  | { type: "pause" }
  | { type: "tick" }
  | { type: "step"; delta: number }
  | { type: "seek"; index: number }
  | { type: "setSpeed"; speed: TimelineSpeed }
  | { type: "goLive" }
  | { type: "unavailable"; reason: string };

export function createSpectatorTimelineState(length = 0): SpectatorTimelineState {
  return {
    mode: "live",
    status: "ready",
    playing: false,
    speed: 1,
    cursor: Math.max(0, length - 1),
    length,
    unavailableReason: null,
  };
}

function clampCursor(index: number, length: number): number {
  if (length <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), length - 1);
}

/**
 * Apply one timeline action. Pure: returns a new state and never throws, so a
 * malformed action from the UI cannot put the timeline in an invalid cursor position.
 */
export function spectatorTimelineReducer(
  state: SpectatorTimelineState,
  action: SpectatorTimelineAction,
): SpectatorTimelineState {
  switch (action.type) {
    case "loaded": {
      const length = Math.max(0, Math.trunc(action.length));
      // A reload recovers from `unavailable`, and a live timeline keeps tracking the newest event.
      const cursor = state.mode === "live" ? Math.max(0, length - 1) : clampCursor(state.cursor, length);
      return { ...state, status: "ready", unavailableReason: null, length, cursor, playing: false };
    }

    case "unavailable":
      return { ...state, status: "unavailable", playing: false, unavailableReason: action.reason };

    default:
      break;
  }

  // Every remaining action is a no-op until the timeline has verified events.
  if (state.status === "unavailable") return state;

  switch (action.type) {
    case "play": {
      if (state.length === 0) return state;
      // Playing from the end restarts from the beginning rather than doing nothing.
      const cursor = state.cursor >= state.length - 1 ? 0 : state.cursor;
      return { ...state, mode: "replay", playing: true, cursor };
    }

    case "pause":
      return { ...state, playing: false };

    case "tick": {
      if (!state.playing) return state;
      // Playback stops on the final event, so the UI timer can be torn down.
      const cursor = Math.min(state.cursor + 1, state.length - 1);
      return { ...state, cursor, playing: cursor < state.length - 1 };
    }

    case "step":
      return { ...state, mode: "replay", playing: false, cursor: clampCursor(state.cursor + action.delta, state.length) };

    case "seek":
      return { ...state, mode: "replay", playing: false, cursor: clampCursor(action.index, state.length) };

    case "setSpeed":
      return { ...state, speed: action.speed };

    case "goLive":
      return { ...state, mode: "live", playing: false, cursor: Math.max(0, state.length - 1) };

    default:
      return state;
  }
}
