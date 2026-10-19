/**
 * Repository-wide fixture builders for protocol domain objects (#1464).
 *
 * These builders are the single source of truth for valid frontend-side
 * protocol fixtures. Every builder returns a fully-valid object so a test can
 * pass only the field(s) under test:
 *
 * ```ts
 * const arena = buildArenaState({ status: "settled" });
 * ```
 *
 * Builders never reach for randomness or the network: the same call always
 * yields the same object, which keeps tests deterministic and makes snapshot
 * diffs meaningful.
 *
 * Alongside every valid default there is an explicit invalid-state helper
 * (`invalidArenaState`, `invalidClaimInboxPage`, …). Invalid helpers exist so a
 * test that needs a malformed payload says so at the call site instead of
 * quietly hand-rolling a field and hoping it is still rejected.
 *
 * @module
 */

import type {
  ArenaState,
  ArenaStateFromContract,
  ArenaStateStatus,
  RoundProofBundle,
} from "@/shared-d/types/contract-state";
import type { ClaimInboxComponent, ClaimInboxItem, ClaimInboxPage } from "@/features/claim-inbox/types";
import type { ArenaStoreSnapshot, ArenaHealthStatus } from "@/features/arena/arenaStore";

/** A well-formed Soroban contract id (C…), 56 chars. */
export const FIXTURE_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
/** A well-formed Stellar account id (G…). */
export const FIXTURE_WALLET_ADDRESS = "GBROXGDHQ3YQ4Z4Y4Z4Y4Z4Y4Z4Y4Z4Y4Z4Y4Z4Y4Z4Y4Z4Y4Z4Y4Z4Y";
/** A well-formed transaction hash (hex, 64 chars). */
export const FIXTURE_TX_HASH = "ab12".repeat(16);

const OPEN_STATUS: ArenaStateStatus = "round_active";

/** Build a valid `ArenaState` (the UI-facing view model). */
export function buildArenaState(overrides: Partial<ArenaState> = {}): ArenaState {
  return {
    id: FIXTURE_CONTRACT_ID,
    status: OPEN_STATUS,
    survivorsCount: 4,
    maxCapacity: 8,
    currentRound: 2,
    isUserIn: true,
    hasWon: false,
    currentStake: 10,
    potentialPayout: 35,
    claimReady: false,
    entryFee: 10,
    playerCount: 4,
    survivors: 4,
    capacity: 8,
    round: 2,
    stakes: 40_000_000n,
    payouts: 0n,
    commitDeadline: 1_700_000_300,
    revealDeadline: 1_700_000_600,
    ...overrides,
  };
}

/** Build a valid `ArenaStateFromContract` (the raw contract read result). */
export function buildArenaStateFromContract(
  overrides: Partial<ArenaStateFromContract> = {},
): ArenaStateFromContract {
  return {
    arenaId: FIXTURE_CONTRACT_ID,
    contractArenaState: {
      survivors: 4,
      capacity: 8,
      round: 2,
      stakes: 40_000_000n,
      payouts: 0n,
    },
    contractUserState: { active: true, won: false },
    gameState: 1,
    entryFee: 10,
    playerCount: 4,
    commitDeadline: 1_700_000_300,
    revealDeadline: 1_700_000_600,
    ...overrides,
  };
}

/** Build a valid arena-store snapshot at a given health. */
export function buildArenaStoreSnapshot(
  overrides: Partial<ArenaStoreSnapshot> = {},
  health: ArenaHealthStatus = "connected",
): ArenaStoreSnapshot {
  return {
    arenaId: FIXTURE_CONTRACT_ID,
    state: buildArenaState(),
    health,
    lastSyncedAt: 1_700_000_000,
    ...overrides,
  };
}

/** Build a valid claim-inbox component (one winnings/refund line). */
export function buildClaimInboxComponent(
  overrides: Partial<ClaimInboxComponent> = {},
): ClaimInboxComponent {
  return {
    kind: "winnings",
    asset: { code: "USDC", issuer: "GISSUER", decimals: 7 },
    amountStroops: "35000000",
    payoutId: "payout-1",
    status: "confirmed",
    txHash: FIXTURE_TX_HASH,
    confirmedAt: "2024-11-14T22:13:20.000Z",
    attempts: 1,
    ...overrides,
  };
}

/** Build a valid claim-inbox item. */
export function buildClaimInboxItem(overrides: Partial<ClaimInboxItem> = {}): ClaimInboxItem {
  const component = overrides.components?.[0] ?? buildClaimInboxComponent();
  return {
    id: "claim-1",
    arenaId: FIXTURE_CONTRACT_ID,
    arenaName: "Fixture Arena",
    kind: "winnings",
    state: "actionable",
    reason: "claim_ready",
    message: "Your winnings are ready to claim.",
    components: [component],
    totalsByAsset: [{ code: "USDC", issuer: "GISSUER", amountStroops: "35000000" }],
    freshness: {
      recordUpdatedAt: "2024-11-14T22:13:20.000Z",
      recordAgeSeconds: 5,
      stale: false,
      ledgerSequence: 1234,
      verifiedAt: "2024-11-14T22:13:25.000Z",
    },
    action: { type: "claim", label: "Claim", endpoint: "/api/claim-inbox/claim" },
    sortKey: "2024-11-14T22:13:20.000Z",
    ...overrides,
  };
}

/**
 * Build a valid claim-inbox page. The summary is recomputed from `items` unless
 * one is supplied, so callers can never accidentally ship a page whose totals
 * disagree with its items.
 */
export function buildClaimInboxPage(overrides: Partial<ClaimInboxPage> = {}): ClaimInboxPage {
  const items = overrides.items ?? [buildClaimInboxItem()];
  return {
    version: 1,
    walletAddress: FIXTURE_WALLET_ADDRESS,
    items,
    summary: {
      actionable: items.filter((i) => i.state === "actionable").length,
      pending: items.filter((i) => i.state === "pending").length,
      completed: items.filter((i) => i.state === "completed").length,
      blocked: items.filter((i) => i.state === "blocked").length,
      unavailable: items.filter((i) => i.state === "unavailable").length,
      total: items.length,
    },
    cursor: null,
    hasMore: false,
    verificationComplete: true,
    scanLatencyMs: 12,
    sources: { payouts: items.length, cancellationRecovery: 0 },
    ...overrides,
  };
}

/** Build a valid round outcome proof bundle. */
export function buildRoundProofBundle(overrides: Partial<RoundProofBundle> = {}): RoundProofBundle {
  return {
    version: 1,
    roundId: "round-1",
    arenaId: FIXTURE_CONTRACT_ID,
    roundNumber: 2,
    network: {
      passphrase: "Test SDF Network ; September 2015",
      arenaContractId: FIXTURE_CONTRACT_ID,
    },
    playerChoices: [
      { userId: "player-1", choice: "heads" },
      { userId: "player-2", choice: "tails" },
    ],
    allActivePlayerIds: ["player-1", "player-2"],
    tally: { heads: 1, tails: 1 },
    eliminatedPlayers: [],
    survivors: ["player-1", "player-2"],
    checksum: "fixture-checksum",
    generatedAt: "2024-11-14T22:13:20.000Z",
    ...overrides,
  };
}

// ─── Invalid-state helpers ──────────────────────────────────────────────────

/**
 * An `ArenaState` that violates a domain invariant: more survivors than
 * capacity. Use only when a test is exercising validation or rejection.
 */
export function invalidArenaState(overrides: Partial<ArenaState> = {}): ArenaState {
  return buildArenaState({ survivors: 99, capacity: 8, ...overrides });
}

/**
 * An `ArenaStateFromContract` whose entry fee is negative, which no real
 * contract read can produce.
 */
export function invalidArenaStateFromContract(
  overrides: Partial<ArenaStateFromContract> = {},
): ArenaStateFromContract {
  return buildArenaStateFromContract({ entryFee: -1, ...overrides });
}

/**
 * A claim-inbox page that fails `claimInboxPageSchema.safeParse`: version 2 and
 * a non-numeric stroop amount. The returned object is deliberately typed as
 * `unknown` so it cannot be passed where a validated page is expected.
 */
export function invalidClaimInboxPage(): unknown {
  return {
    ...buildClaimInboxPage(),
    version: 2,
    items: [buildClaimInboxItem({ components: [buildClaimInboxComponent({ amountStroops: "not-a-number" })] })],
  };
}

/** A claim-inbox component whose asset declares the wrong decimals. */
export function invalidClaimInboxComponent(): unknown {
  return buildClaimInboxComponent({
    asset: { code: "USDC", issuer: null, decimals: 6 as unknown as 7 },
  });
}
