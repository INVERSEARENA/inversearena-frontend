export const ARENA_LOADED = "ARENA_LOADED" as const
export const ROUND_STARTED = "ROUND_STARTED" as const
export const CHOICE_SUBMITTED = "CHOICE_SUBMITTED" as const
export const ROUND_RESOLVED = "ROUND_RESOLVED" as const
export const PLAYER_ELIMINATED = "PLAYER_ELIMINATED" as const
export const ARENA_ENDED = "ARENA_ENDED" as const
export const TIMER_TICK = "TIMER_TICK" as const

export type ArenaStatus =
  | "PENDING"
  | "JOINING"
  | "ACTIVE"
  | "RESOLVING"
  | "ENDED"
  | "CANCELLED"

export type ArenaChoiceSide = "HEADS" | "TAILS"
export type ArenaPlayerStatus = "OBSERVING" | "ALIVE" | "ELIMINATED"

export interface ArenaPopulationSplit {
  heads: number
  tails: number
}

export interface ArenaEliminationLogEntry {
  type:
    | typeof CHOICE_SUBMITTED
    | typeof ROUND_RESOLVED
    | typeof PLAYER_ELIMINATED
    | typeof ARENA_ENDED
  round: number
  timestamp: number
  choice?: ArenaChoiceSide
  eliminatedSide?: ArenaChoiceSide
  eliminatedCount?: number
  survivorsAfterRound?: number
  playerEliminated?: boolean
}

export interface ArenaReducerState {
  status: ArenaStatus
  currentRound: number
  timer: number
  populationSplit: ArenaPopulationSplit
  survivors: number
  yieldPot: number
  playerStatus: ArenaPlayerStatus
  eliminationLog: ArenaEliminationLogEntry[]
}

export interface ArenaLoadedAction {
  type: typeof ARENA_LOADED
  payload: ArenaReducerState
}

export interface RoundStartedAction {
  type: typeof ROUND_STARTED
  payload: {
    currentRound: number
    timer: number
  }
}

export interface ChoiceSubmittedAction {
  type: typeof CHOICE_SUBMITTED
  payload: {
    round: number
    choice: ArenaChoiceSide
    timestamp?: number
  }
}

export interface RoundResolvedAction {
  type: typeof ROUND_RESOLVED
  payload: {
    round: number
    eliminatedSide: ArenaChoiceSide
    eliminatedCount: number
    survivors: number
    yieldPot: number
    populationSplit: ArenaPopulationSplit
    timestamp?: number
  }
}

export interface PlayerEliminatedAction {
  type: typeof PLAYER_ELIMINATED
  payload?: {
    round?: number
    timestamp?: number
  }
}

export interface ArenaEndedAction {
  type: typeof ARENA_ENDED
  payload?: {
    status?: "ENDED" | "CANCELLED"
    timestamp?: number
  }
}

export interface TimerTickAction {
  type: typeof TIMER_TICK
}

export type ArenaAction =
  | ArenaLoadedAction
  | RoundStartedAction
  | ChoiceSubmittedAction
  | RoundResolvedAction
  | PlayerEliminatedAction
  | ArenaEndedAction
  | TimerTickAction

export const initialArenaState: ArenaReducerState = {
  status: "PENDING",
  currentRound: 0,
  timer: 0,
  populationSplit: { heads: 0, tails: 0 },
  survivors: 0,
  yieldPot: 0,
  playerStatus: "OBSERVING",
  eliminationLog: [],
}

function asNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function asFiniteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function normalizePopulationSplit(
  split: ArenaPopulationSplit
): ArenaPopulationSplit {
  return {
    heads: asNonNegativeInteger(split.heads),
    tails: asNonNegativeInteger(split.tails),
  }
}

function isTerminal(status: ArenaStatus): boolean {
  return status === "ENDED" || status === "CANCELLED"
}

function findPlayerChoiceForRound(
  logEntries: ArenaEliminationLogEntry[],
  round: number
): ArenaChoiceSide | undefined {
  for (let i = logEntries.length - 1; i >= 0; i -= 1) {
    const entry = logEntries[i]
    if (entry.type === CHOICE_SUBMITTED && entry.round === round && entry.choice) {
      return entry.choice
    }
  }
  return undefined
}

function nowOr(timestamp?: number): number {
  return typeof timestamp === "number" && Number.isFinite(timestamp)
    ? timestamp
    : Date.now()
}

export function arenaReducer(
  state: ArenaReducerState,
  action: ArenaAction
): ArenaReducerState {
  switch (action.type) {
    case ARENA_LOADED: {
      return {
        status: action.payload.status,
        currentRound: asNonNegativeInteger(action.payload.currentRound),
        timer: asNonNegativeInteger(action.payload.timer),
        populationSplit: normalizePopulationSplit(action.payload.populationSplit),
        survivors: asNonNegativeInteger(action.payload.survivors),
        yieldPot: asFiniteNumber(action.payload.yieldPot),
        playerStatus: action.payload.playerStatus,
        eliminationLog: action.payload.eliminationLog.map((entry) => ({ ...entry })),
      }
    }

    case ROUND_STARTED: {
      if (isTerminal(state.status)) return state

      return {
        ...state,
        status: "ACTIVE",
        currentRound: asNonNegativeInteger(action.payload.currentRound),
        timer: asNonNegativeInteger(action.payload.timer),
      }
    }

    case CHOICE_SUBMITTED: {
      if (isTerminal(state.status)) return state

      const round = asNonNegativeInteger(action.payload.round)

      const logEntry: ArenaEliminationLogEntry = {
        type: CHOICE_SUBMITTED,
        round,
        choice: action.payload.choice,
        timestamp: nowOr(action.payload.timestamp),
      }

      return {
        ...state,
        playerStatus: state.playerStatus === "OBSERVING" ? "ALIVE" : state.playerStatus,
        eliminationLog: [...state.eliminationLog, logEntry],
      }
    }

    case ROUND_RESOLVED: {
      if (isTerminal(state.status)) return state

      const round = asNonNegativeInteger(action.payload.round)
      const survivors = asNonNegativeInteger(action.payload.survivors)
      const playerChoice = findPlayerChoiceForRound(state.eliminationLog, round)
      const playerEliminated =
        state.playerStatus !== "ELIMINATED" &&
        playerChoice === action.payload.eliminatedSide

      const logEntry: ArenaEliminationLogEntry = {
        type: ROUND_RESOLVED,
        round,
        eliminatedSide: action.payload.eliminatedSide,
        eliminatedCount: asNonNegativeInteger(action.payload.eliminatedCount),
        survivorsAfterRound: survivors,
        playerEliminated,
        timestamp: nowOr(action.payload.timestamp),
      }

      return {
        ...state,
        status: survivors <= 1 ? "ENDED" : "ACTIVE",
        currentRound: round,
        timer: 0,
        populationSplit: normalizePopulationSplit(action.payload.populationSplit),
        survivors,
        yieldPot: asFiniteNumber(action.payload.yieldPot),
        playerStatus: playerEliminated ? "ELIMINATED" : state.playerStatus,
        eliminationLog: [...state.eliminationLog, logEntry],
      }
    }

    case PLAYER_ELIMINATED: {
      if (state.playerStatus === "ELIMINATED") return state

      const logEntry: ArenaEliminationLogEntry = {
        type: PLAYER_ELIMINATED,
        round: asNonNegativeInteger(action.payload?.round ?? state.currentRound),
        playerEliminated: true,
        timestamp: nowOr(action.payload?.timestamp),
      }

      return {
        ...state,
        playerStatus: "ELIMINATED",
        eliminationLog: [...state.eliminationLog, logEntry],
      }
    }

    case ARENA_ENDED: {
      const terminalStatus = action.payload?.status ?? "ENDED"

      const logEntry: ArenaEliminationLogEntry = {
        type: ARENA_ENDED,
        round: state.currentRound,
        timestamp: nowOr(action.payload?.timestamp),
      }

      return {
        ...state,
        status: terminalStatus,
        timer: 0,
        eliminationLog: [...state.eliminationLog, logEntry],
      }
    }

    case TIMER_TICK: {
      if (state.timer <= 0) return state

      return {
        ...state,
        timer: state.timer - 1,
      }
    }

    default:
      return state
  }
}
