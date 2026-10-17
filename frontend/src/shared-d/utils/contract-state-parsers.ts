import type { xdr } from "@stellar/stellar-sdk";
import type {
  ArenaState,
  ContractArenaState,
  ContractUserState,
  ProofBundleTally,
  RoundProofBundle,
  UserState,
} from "@/shared-d/types/contract-state";
import { ROUND_PROOF_BUNDLE_VERSION } from "@/shared-d/types/contract-state";
import {
  extractBoolFromScVal,
  extractI128FromScVal,
  extractU32FromScVal,
  stroopsToDisplayAmount,
} from "@/shared-d/utils/stellar-scval-extract";

export function parseArenaStateFromScVal(stateData: xdr.ScVal): ContractArenaState {
  return {
    survivors: extractU32FromScVal(stateData, "survivors_count") ?? 0,
    capacity: extractU32FromScVal(stateData, "max_capacity") ?? 0,
    round: extractU32FromScVal(stateData, "round_number") ?? 0,
    stakes: extractI128FromScVal(stateData, "current_stake") ?? 0n,
    payouts: extractI128FromScVal(stateData, "potential_payout") ?? 0n,
  };
}

export function parseUserStateFromScVal(userData: xdr.ScVal): ContractUserState {
  return {
    active: extractBoolFromScVal(userData, "is_active") ?? false,
    won: extractBoolFromScVal(userData, "has_won") ?? false,
  };
}

export function buildArenaDisplayState(arenaState: ContractArenaState): Pick<
  import("@/shared-d/types/contract-state").FetchArenaStateResult,
  | "survivorsCount"
  | "maxCapacity"
  | "currentStake"
  | "potentialPayout"
  | "roundNumber"
  | "currentStakeStroops"
  | "potentialPayoutStroops"
> {
  return {
    survivorsCount: arenaState.survivors,
    maxCapacity: arenaState.capacity,
    currentStake: stroopsToDisplayAmount(arenaState.stakes),
    potentialPayout: stroopsToDisplayAmount(arenaState.payouts),
    roundNumber: arenaState.round,
    currentStakeStroops: arenaState.stakes,
    potentialPayoutStroops: arenaState.payouts,
  };
}

// ─── Round outcome proof bundle verification (#1394) ────────────────────────
//
// A client should never trust the backend's `resolution.eliminatedPlayers` /
// `survivors` claims at face value — `recomputeSurvivorship` independently
// re-derives them from the bundle's raw `playerChoices` +
// `allActivePlayerIds` inputs, faithfully reproducing the *two* elimination
// rules the on-chain contract applies in `resolve_players`
// (`contract/arena/src/lib.rs`, `contract/arena/src/eliminations.rs`):
//
//  1. Minority-wins tally rule: among players who revealed a choice, the
//     side with fewer votes survives; the majority is eliminated. A strict
//     tie (both sides nonzero and equal) is inconclusive — no revealer is
//     eliminated by this rule on a tie. If only one side has any votes, that
//     side survives (there is no opposing majority).
//  2. AFK rule: a player in `allActivePlayerIds` who does NOT appear in
//     `playerChoices` (did not reveal) is eliminated unconditionally — this
//     is independent of rule 1 and still applies even when rule 1 is a tie.
//     This is `resolve_players`'s `choice.map(is_eliminated).unwrap_or(true)`:
//     the `unwrap_or(true)` is the AFK path.
//
// See `docs/round-outcome-proof-bundle.md` for the full design note.

/** A structural (not cryptographic-signature) validation failure — the bundle's shape doesn't match what this client expects. */
export class ProofBundleShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProofBundleShapeError";
  }
}

/** The bundle's `network` doesn't match the network the caller is currently verifying against (e.g. a testnet bundle checked against mainnet, or vice versa). */
export class ProofBundleNetworkMismatchError extends Error {
  constructor(
    readonly expected: { passphrase: string; arenaContractId: string },
    readonly actual: { passphrase: string; arenaContractId: string },
  ) {
    super(
      `Proof bundle network mismatch: expected passphrase="${expected.passphrase}" ` +
        `arenaContractId="${expected.arenaContractId}", got passphrase="${actual.passphrase}" ` +
        `arenaContractId="${actual.arenaContractId}"`,
    );
    this.name = "ProofBundleNetworkMismatchError";
  }
}

export type SurvivingSide = "heads" | "tails" | null;

/**
 * The surviving choice under minority-wins rules — mirrors
 * `eliminations::surviving_choice` in `contract/arena/src/eliminations.rs`
 * exactly, including its tie/zero-vote edge cases.
 */
export function computeSurvivingChoice(tally: ProofBundleTally): SurvivingSide {
  const { heads, tails } = tally;
  if (heads === 0 && tails === 0) return null;
  if (tails === 0) return "heads";
  if (heads === 0) return "tails";
  if (heads === tails) return null;
  return heads < tails ? "heads" : "tails";
}

export interface SurvivorshipRecomputation {
  /** The surviving choice this client independently derived from `playerChoices`, or null on a tie/no-reveals. */
  survivingChoice: SurvivingSide;
  /** The heads/tails tally this client independently derived from `playerChoices` (does not trust `bundle.tally`). */
  recomputedTally: ProofBundleTally;
  /** Eliminated player ids this client independently derived (revealed-minority-loses ∪ non-revealers). Sorted. */
  recomputedEliminatedPlayers: string[];
  /** Survivor player ids this client independently derived (`allActivePlayerIds` minus `recomputedEliminatedPlayers`). Sorted. */
  recomputedSurvivors: string[];
  /** Player ids present in `allActivePlayerIds` but absent from `playerChoices` — eliminated unconditionally under the AFK rule. Sorted. */
  nonRevealers: string[];
  /** True iff the client's independent recomputation matches every backend-claimed field the bundle carries (`tally`, `eliminatedPlayers`, `survivors`). */
  matchesBundleClaim: boolean;
  /** Per-field mismatch detail when `matchesBundleClaim` is false, otherwise empty. */
  mismatches: string[];
}

function sortedUnique(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/**
 * Recompute round survivorship from a proof bundle's raw inputs, independent
 * of (and without trusting) the bundle's own `tally` / `eliminatedPlayers` /
 * `survivors` claims, then report whether the two agree.
 *
 * This function only validates internal consistency of the bundle contents
 * against the known game mechanic — it does NOT verify `bundle.checksum`
 * (use `verifyProofBundleChecksum`) and does NOT verify the bundle's network
 * matches the caller's expected network (use `assertProofBundleNetwork`).
 * Callers should run all three checks before trusting a bundle's verdict.
 *
 * @throws ProofBundleShapeError if the bundle's version is unrecognized or
 *   required arrays are structurally invalid (duplicate/overlapping ids,
 *   revealer not present in allActivePlayerIds, etc. — a well-formed bundle
 *   from `RoundProofBundleService` never produces these, so seeing one here
 *   means the bundle was tampered with or corrupted in transit).
 */
export function recomputeSurvivorship(bundle: RoundProofBundle): SurvivorshipRecomputation {
  if (bundle.version !== ROUND_PROOF_BUNDLE_VERSION) {
    throw new ProofBundleShapeError(
      `Unsupported proof bundle version: expected ${ROUND_PROOF_BUNDLE_VERSION}, got ${bundle.version}`,
    );
  }
  if (!Array.isArray(bundle.allActivePlayerIds) || bundle.allActivePlayerIds.length === 0) {
    throw new ProofBundleShapeError("Proof bundle has an empty or missing allActivePlayerIds");
  }
  if (!Array.isArray(bundle.playerChoices)) {
    throw new ProofBundleShapeError("Proof bundle has a missing playerChoices array");
  }

  const activeSet = new Set(bundle.allActivePlayerIds);
  if (activeSet.size !== bundle.allActivePlayerIds.length) {
    throw new ProofBundleShapeError("Proof bundle's allActivePlayerIds contains duplicate ids");
  }

  const revealerIds = new Set<string>();
  const recomputedTally: ProofBundleTally = { heads: 0, tails: 0 };
  for (const entry of bundle.playerChoices) {
    if (entry.choice !== "heads" && entry.choice !== "tails") {
      throw new ProofBundleShapeError(`Proof bundle has an invalid choice for player ${entry.userId}`);
    }
    if (!activeSet.has(entry.userId)) {
      throw new ProofBundleShapeError(
        `Proof bundle's playerChoices contains ${entry.userId}, who is not in allActivePlayerIds`,
      );
    }
    if (revealerIds.has(entry.userId)) {
      throw new ProofBundleShapeError(`Proof bundle has a duplicate playerChoices entry for ${entry.userId}`);
    }
    revealerIds.add(entry.userId);
    if (entry.choice === "heads") recomputedTally.heads += 1;
    else recomputedTally.tails += 1;
  }

  const nonRevealers = sortedUnique(bundle.allActivePlayerIds.filter((id) => !revealerIds.has(id)));
  const survivingChoice = computeSurvivingChoice(recomputedTally);

  const eliminatedRevealers = bundle.playerChoices
    .filter((entry) => survivingChoice !== null && entry.choice !== survivingChoice)
    .map((entry) => entry.userId);

  const recomputedEliminatedPlayers = sortedUnique([...eliminatedRevealers, ...nonRevealers]);
  const recomputedSurvivors = sortedUnique(
    bundle.allActivePlayerIds.filter((id) => !recomputedEliminatedPlayers.includes(id)),
  );

  const mismatches: string[] = [];
  if (recomputedTally.heads !== bundle.tally.heads || recomputedTally.tails !== bundle.tally.tails) {
    mismatches.push(
      `tally: recomputed heads=${recomputedTally.heads} tails=${recomputedTally.tails}, ` +
        `bundle claims heads=${bundle.tally.heads} tails=${bundle.tally.tails}`,
    );
  }
  const bundleEliminated = sortedUnique(bundle.eliminatedPlayers);
  if (!arraysEqual(recomputedEliminatedPlayers, bundleEliminated)) {
    mismatches.push(
      `eliminatedPlayers: recomputed [${recomputedEliminatedPlayers.join(",")}], ` +
        `bundle claims [${bundleEliminated.join(",")}]`,
    );
  }
  const bundleSurvivors = sortedUnique(bundle.survivors);
  if (!arraysEqual(recomputedSurvivors, bundleSurvivors)) {
    mismatches.push(
      `survivors: recomputed [${recomputedSurvivors.join(",")}], bundle claims [${bundleSurvivors.join(",")}]`,
    );
  }

  return {
    survivingChoice,
    recomputedTally,
    recomputedEliminatedPlayers,
    recomputedSurvivors,
    nonRevealers,
    matchesBundleClaim: mismatches.length === 0,
    mismatches,
  };
}

/**
 * Refuse to compare a bundle produced for one Stellar network against
 * another (#1394 edge case: "network mismatch") — a testnet bundle's
 * `eliminatedPlayers` are meaningless for a mainnet arena with the same
 * roundId format, so this must be checked explicitly rather than left to
 * coincidence.
 *
 * @throws ProofBundleNetworkMismatchError if the bundle's `network` doesn't
 *   exactly match `expected`.
 */
export function assertProofBundleNetwork(
  bundle: RoundProofBundle,
  expected: { passphrase: string; arenaContractId: string },
): void {
  if (
    bundle.network.passphrase !== expected.passphrase ||
    bundle.network.arenaContractId !== expected.arenaContractId
  ) {
    throw new ProofBundleNetworkMismatchError(expected, bundle.network);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Canonical, deterministic JSON stringify: object keys sorted recursively.
 * Must stay byte-for-byte identical to the backend's
 * `roundProofBundleService.ts`'s `canonicalStringify` — this is what makes
 * `bundle.checksum` reproducible client-side. Array element order is kept
 * as-is since it's semantically meaningful (e.g. `playerChoices` sorted by
 * `userId` by the backend).
 */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalStringify((value as Record<string, unknown>)[key])}`,
  );
  return `{${entries.join(",")}}`;
}

/**
 * Verify `bundle.checksum` is the correct SHA-256 of the bundle's own
 * canonical JSON (excluding the checksum field itself), using WebCrypto —
 * matching this codebase's existing client-side hashing convention (see
 * `commit-reveal.ts`'s `computeCommitment`). This detects any tampering or
 * transport corruption of the bundle's fields, independent of whether the
 * *contents* are internally consistent (that's `recomputeSurvivorship`'s job).
 */
export async function verifyProofBundleChecksum(bundle: RoundProofBundle): Promise<boolean> {
  const { checksum, ...rest } = bundle;
  const canonical = canonicalStringify(rest);
  // TextEncoder().encode() types its result as Uint8Array<ArrayBufferLike>,
  // which SubtleCrypto's BufferSource overloads don't accept directly under
  // this project's lib target; copy into a plain ArrayBuffer-backed view
  // (same fix shape as `commit-reveal.ts`'s hand-built Uint8Array preimage).
  const encoded = new TextEncoder().encode(canonical);
  const bytes = new Uint8Array(encoded.length);
  bytes.set(encoded);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest)) === checksum;
}
