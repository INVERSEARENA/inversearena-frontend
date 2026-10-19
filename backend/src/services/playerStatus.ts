/**
 * Arena `get_player_status` result shape and its strict decoder (#1582).
 *
 * Kept free of RPC imports so eligibility logic and its tests can depend on it
 * without loading the Soroban client.
 */
import type { OnChainReadResult } from "../types/onChainRead";

/** Mirrors `ArenaPhase` in `contract/arena/src/types.rs` (#1582). */
export const ARENA_PHASES = [
  "Lobby",
  "Commit",
  "Reveal",
  "Intermission",
  "Finished",
  "Settled",
  "Cancelled",
] as const;
export type OnChainArenaPhase = (typeof ARENA_PHASES)[number];

/** Mirrors `EliminationReason` in `contract/arena/src/types.rs` (#1582). */
export const ELIMINATION_REASONS = [
  "NotEliminated",
  "Majority",
  "NoReveal",
  "NoCommit",
  "Unrecorded",
] as const;
export type OnChainEliminationReason = (typeof ELIMINATION_REASONS)[number];

/** Decoded `get_player_status` result (#1582). */
export interface OnChainPlayerStatus {
  joined: boolean;
  active: boolean;
  committed: boolean;
  revealed: boolean;
  eliminatedRound: number | null;
  eliminationReason: OnChainEliminationReason;
  refundClaimed: boolean;
  winner: boolean;
  currentRound: number;
  phase: OnChainArenaPhase;
}

/**
 * Decode `get_player_status`'s `PlayerStatus` struct. Throws on any missing
 * field or unknown variant, so a malformed answer becomes `unavailable`
 * rather than a guessed status.
 */
export function decodePlayerStatus(raw: unknown): OnChainPlayerStatus {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("PlayerStatus is not a struct");
  }
  const fields = raw as Record<string, unknown>;
  const bool = (key: string): boolean => {
    if (typeof fields[key] !== "boolean") throw new Error(`PlayerStatus.${key} is not a bool`);
    return fields[key] as boolean;
  };
  const u32 = (key: string): number => {
    const value = Number(fields[key] as number | bigint);
    if (!Number.isInteger(value) || value < 0) throw new Error(`PlayerStatus.${key} is not a u32`);
    return value;
  };
  // A fieldless #[contracttype] enum variant decodes to a one-element array.
  const variant = <T extends string>(key: string, variants: readonly T[]): T => {
    const value = fields[key];
    const name = Array.isArray(value) && value.length === 1 ? value[0] : undefined;
    const match = variants.find((candidate) => candidate === name);
    if (!match) throw new Error(`PlayerStatus.${key} has unknown variant ${String(name)}`);
    return match;
  };

  return {
    joined: bool("joined"),
    active: bool("active"),
    committed: bool("committed"),
    revealed: bool("revealed"),
    eliminatedRound: fields.eliminated_round == null ? null : u32("eliminated_round"),
    eliminationReason: variant("elimination_reason", ELIMINATION_REASONS),
    refundClaimed: bool("refund_claimed"),
    winner: bool("winner"),
    currentRound: u32("current_round"),
    phase: variant("phase", ARENA_PHASES),
  };
}

/** Reads a player's on-chain arena status; `readOnChainPlayerStatus` in production. */
export type PlayerStatusReader = (
  contractId: string,
  player: string,
) => Promise<OnChainReadResult<OnChainPlayerStatus>>;
