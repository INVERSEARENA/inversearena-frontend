import { z } from 'zod';
import { Money } from './money';
import { MoneySchema } from '../validation/payloadLimits';

export enum RoundState {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  RESOLVED = 'RESOLVED',
  SETTLED = 'SETTLED'
}

export const PlayerChoiceSchema = z.object({
  userId: z.string().uuid(),
  choice: z.enum(['heads', 'tails']),
  stake: MoneySchema,
});

export const RoundInputSchema = z.object({
  roundId: z.string().uuid(),
  playerChoices: z.array(PlayerChoiceSchema).min(1).max(500),
  allActivePlayerIds: z.array(z.string().uuid()).min(1).max(500),
  oracleYield: z.number().finite().min(0).max(100),
  randomSeed: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  arenaContractId: z.string().regex(/^C[A-Z2-7]{55}$/, "must be a valid Stellar contract ID (C...)"),
});

export interface PlayerChoice {
  userId: string;
  choice: string;
  stake: Money;
}

export interface RoundInput {
  roundId: string;
  playerChoices: PlayerChoice[];
  allActivePlayerIds: string[];
  oracleYield: number;
  randomSeed?: string;
  arenaContractId: string;
}

export interface Payout {
  userId: string;
  amount: Money;
  /**
   * Settlement breakdown (#1407) for this payout — see
   * domain/settlement.computeSettlementBreakdown. principal + yieldAmount
   * always equals amount + platformFee + dust.
   */
  principal: Money;
  yieldAmount: Money;
  platformFee: Money;
  dust: Money;
}

export interface RoundResolution {
  eliminatedPlayers: string[];
  payouts: Payout[];
  poolBalances: Record<string, Money>;
}

export interface RoundMetadata {
  playerChoices: PlayerChoice[];
  oracleYield: number;
  randomSeed: string | undefined;
  resolution: RoundResolution | undefined;
  /**
   * All player ids the contract considered active when this round was
   * resolved (revealers + non-revealers), i.e. `RoundInput.allActivePlayerIds`
   * as it stood at resolution time (#1394). Persisted so the proof bundle can
   * be reassembled later without re-deriving it from `playerChoices` alone,
   * which would silently drop non-revealers (see
   * `docs/round-outcome-proof-bundle.md`).
   *
   * Optional because rounds resolved before this field was introduced have
   * no value for it; `RoundProofBundleService` treats that as a legacy round
   * it cannot produce a bundle for (see the design note's compatibility
   * section) rather than guessing.
   */
  allActivePlayerIds: string[] | undefined;
}

export interface PaginatedResult<T> {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
}

export interface RoundData {
  id: string;
  arenaId: string;
  roundNumber: number;
  state: RoundState;
  playerChoices: PlayerChoice[];
  oracleYield: number | undefined;
  randomSeed: string | undefined;
  resolution: RoundResolution | undefined;
  metadata: RoundMetadata | undefined;
  /** See `RoundMetadata.allActivePlayerIds` (#1394). */
  allActivePlayerIds: string[] | undefined;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Round outcome proof bundle (#1394) ─────────────────────────────────────
//
// A self-contained, structurally verifiable record of how a resolved round's
// survivor set was derived, published so a client does not have to blindly
// trust the backend's `resolution.eliminatedPlayers` list. See
// `docs/round-outcome-proof-bundle.md` for the full design note.

/** Schema version of the proof bundle payload. Bump on any breaking shape change. */
export const ROUND_PROOF_BUNDLE_VERSION = 1 as const;

/**
 * A single player's revealed choice as carried in the bundle. Only players
 * who actually revealed (i.e. appear in `playerChoices` at resolution time)
 * are included. Non-revealers are a *distinct* elimination path in the
 * contract (`resolve_players`'s `choice.map(is_eliminated).unwrap_or(true)`
 * in `contract/arena/src/lib.rs`): they are eliminated unconditionally,
 * independent of the tally and even on a tie, unlike revealers who are only
 * eliminated when their choice is the tallied majority. A client's
 * `recomputeSurvivorship` (frontend) must apply both rules — not just the
 * minority-wins tally rule — using `allActivePlayerIds` minus
 * `playerChoices` to find the non-revealer set.
 */
export interface ProofBundlePlayerChoice {
  userId: string;
  choice: 'heads' | 'tails';
}

/** Revealed-choice tally the bundle claims for the round, mirroring the
 * contract's `eliminations::Tally` and the `round_resolved_v2` (`rslvd2`)
 * event's `heads_count` / `tails_count` fields. */
export interface ProofBundleTally {
  heads: number;
  tails: number;
}

/**
 * Which network the bundle was produced against. Included so a client can
 * refuse to verify a testnet bundle against mainnet contract state (or vice
 * versa) instead of silently comparing incompatible data (#1394 edge case:
 * "network mismatch").
 */
export interface ProofBundleNetwork {
  /** Stellar network passphrase the backend was configured with when the bundle was assembled. */
  passphrase: string;
  /** Soroban contract id (C...) of the arena this round belongs to. */
  arenaContractId: string;
}

export interface RoundProofBundle {
  version: typeof ROUND_PROOF_BUNDLE_VERSION;
  roundId: string;
  arenaId: string;
  roundNumber: number;
  network: ProofBundleNetwork;
  /** Revealed choices used as the recomputation input. Sorted by `userId` for a stable, hashable serialization. */
  playerChoices: ProofBundlePlayerChoice[];
  /** All player ids considered active entering this round (revealers + non-revealers). */
  allActivePlayerIds: string[];
  tally: ProofBundleTally;
  /** Eliminated player ids as claimed by the backend — the thing the client's recomputation verifies. */
  eliminatedPlayers: string[];
  /** Survivor player ids as claimed by the backend. */
  survivors: string[];
  /** SHA-256 hex digest of the bundle's canonical (deterministic) JSON form, excluding this field itself. */
  checksum: string;
  /** ISO-8601 timestamp of when the bundle was assembled. */
  generatedAt: string;
}
