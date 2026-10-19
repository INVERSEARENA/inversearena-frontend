/**
 * Repository-wide fixture builders for backend protocol domain objects (#1464).
 *
 * The backend suite had grown ~100 per-file make/build/prisma-mock helpers,
 * each re-deriving the same protocol objects and drifting independently. This
 * module is the single source of truth for the backend half of those objects.
 *
 * Every builder returns a fully-valid object so a test passes only the field(s)
 * under test; every valid builder has an explicit `invalid*` sibling so a test
 * that needs a malformed payload says so at the call site. Builders are pure and
 * deterministic — no clock, no randomness, no network — so a build is repeatable
 * and a diff is meaningful.
 *
 * @module
 */

import { Money } from "../../src/types/money";
import {
  RoundState,
  ROUND_PROOF_BUNDLE_VERSION,
  type CommitReceipt,
  type PlayerChoice,
  type Payout,
  type RoundData,
  type RoundInput,
  type RoundProofBundle,
  type RoundResolution,
} from "../../src/types/round";
import type {
  ClaimInboxComponent,
  ClaimInboxItem,
  ClaimInboxPage,
} from "../../src/types/claimInbox";
import {
  initialArenaProjection,
  type ArenaProjectionState,
} from "../../src/services/projection/arenaProjectionFold";
import type { ArenaProjectionEvent } from "../../src/services/projection/arenaEventTypes";

/** A well-formed Soroban contract id (C…), 56 chars. */
export const FIXTURE_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
/** A well-formed Stellar account id (G…), 56 chars. */
export const FIXTURE_WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
/** A well-formed transaction hash (hex, 64 chars). */
export const FIXTURE_TX_HASH = "ab12".repeat(16);
/** A well-formed UUID, used for round and player ids. */
export const FIXTURE_UUID = "11111111-1111-4111-8111-111111111111";

/** Build a monetary amount. Defaults to 10 XLM. */
export function buildMoney(atomicAmount: bigint | string = 100_000_000n): Money {
  return new Money(atomicAmount, "XLM");
}

/** Build a player choice as consumed by the round engine. */
export function buildPlayerChoice(overrides: Partial<PlayerChoice> = {}): PlayerChoice {
  return {
    userId: FIXTURE_UUID,
    choice: "heads",
    stake: buildMoney(),
    ...overrides,
  };
}

/** Build a payout with a self-consistent settlement breakdown. */
export function buildPayout(overrides: Partial<Payout> = {}): Payout {
  return {
    userId: FIXTURE_UUID,
    amount: buildMoney(90_999_999n),
    principal: buildMoney(10_000_000n),
    yieldAmount: buildMoney(90_000_000n),
    platformFee: buildMoney(9_000_000n),
    dust: buildMoney(1n),
    ...overrides,
  };
}

/** Build a round resolution. */
export function buildRoundResolution(overrides: Partial<RoundResolution> = {}): RoundResolution {
  return {
    eliminatedPlayers: [],
    payouts: [buildPayout()],
    poolBalances: { XLM: buildMoney() },
    ...overrides,
  };
}

/** Build a valid `RoundInput` (satisfies `RoundInputSchema`). */
export function buildRoundInput(overrides: Partial<RoundInput> = {}): RoundInput {
  return {
    roundId: FIXTURE_UUID,
    playerChoices: [buildPlayerChoice()],
    allActivePlayerIds: [FIXTURE_UUID],
    oracleYield: 5,
    arenaContractId: FIXTURE_CONTRACT_ID,
    ...overrides,
  };
}

/**
 * Build the wire form of a round input — the shape `RoundInputSchema` accepts,
 * with `Money` flattened to `{ atomicAmount, assetCode }`. Use this when a test
 * needs to cross the validation boundary; `buildRoundInput` stays in the
 * domain `Money` form for everything downstream of it.
 */
export function buildRoundInputPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    roundId: FIXTURE_UUID,
    playerChoices: [
      { userId: FIXTURE_UUID, choice: "heads", stake: { atomicAmount: "100000000", assetCode: "XLM" } },
    ],
    allActivePlayerIds: [FIXTURE_UUID],
    oracleYield: 5,
    arenaContractId: FIXTURE_CONTRACT_ID,
    ...overrides,
  };
}

/** Build a persisted round row. */
export function buildRoundData(overrides: Partial<RoundData> = {}): RoundData {
  const metadata = overrides.metadata ?? {
    playerChoices: [buildPlayerChoice()],
    oracleYield: 5,
    randomSeed: undefined,
    resolution: undefined,
    allActivePlayerIds: [FIXTURE_UUID],
  };
  return {
    id: FIXTURE_UUID,
    arenaId: FIXTURE_CONTRACT_ID,
    roundNumber: 1,
    state: RoundState.OPEN,
    playerChoices: metadata.playerChoices,
    oracleYield: metadata.oracleYield,
    randomSeed: metadata.randomSeed,
    resolution: metadata.resolution,
    metadata,
    allActivePlayerIds: metadata.allActivePlayerIds,
    createdAt: new Date("2024-11-14T22:13:20.000Z"),
    updatedAt: new Date("2024-11-14T22:13:20.000Z"),
    ...overrides,
  };
}

/** Build a version-1 round outcome proof bundle. */
export function buildRoundProofBundle(overrides: Partial<RoundProofBundle> = {}): RoundProofBundle {
  return {
    version: ROUND_PROOF_BUNDLE_VERSION,
    roundId: FIXTURE_UUID,
    arenaId: FIXTURE_CONTRACT_ID,
    roundNumber: 1,
    network: {
      passphrase: "Test SDF Network ; September 2015",
      arenaContractId: FIXTURE_CONTRACT_ID,
    },
    playerChoices: [{ userId: FIXTURE_UUID, choice: "heads" }],
    allActivePlayerIds: [FIXTURE_UUID],
    tally: { heads: 1, tails: 0 },
    eliminatedPlayers: [],
    survivors: [FIXTURE_UUID],
    checksum: "fixture-checksum",
    generatedAt: "2024-11-14T22:13:20.000Z",
    ...overrides,
  };
}

/** Build a round-scoped commit receipt in the `accepted` state. */
export function buildCommitReceipt(overrides: Partial<CommitReceipt> = {}): CommitReceipt {
  return {
    arenaId: FIXTURE_CONTRACT_ID,
    roundNumber: 1,
    walletAddress: FIXTURE_WALLET,
    status: "accepted",
    choice: "heads",
    asOf: "2024-11-14T22:13:20.000Z",
    ...overrides,
  };
}

/** Build a claim-inbox component (one money movement). */
export function buildClaimInboxComponent(
  overrides: Partial<ClaimInboxComponent> = {},
): ClaimInboxComponent {
  return {
    kind: "winnings",
    asset: { code: "XLM", issuer: null, decimals: 7 },
    amountStroops: "90000000",
    payoutId: "payout-1",
    status: "confirmed",
    txHash: FIXTURE_TX_HASH,
    confirmedAt: "2024-11-14T22:13:20.000Z",
    attempts: 1,
    ...overrides,
  };
}

/** Build a claim-inbox item (one wallet position in one arena). */
export function buildClaimInboxItem(overrides: Partial<ClaimInboxItem> = {}): ClaimInboxItem {
  const component = overrides.components?.[0] ?? buildClaimInboxComponent();
  return {
    id: FIXTURE_CONTRACT_ID,
    arenaId: FIXTURE_CONTRACT_ID,
    arenaName: "Fixture Arena",
    kind: "winnings",
    state: "actionable",
    reason: "claim_ready",
    message: "Your winnings are ready to claim.",
    components: [component],
    totalsByAsset: [{ code: component.asset.code, issuer: component.asset.issuer, amountStroops: component.amountStroops }],
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

/** Build a claim-inbox page whose summary is derived from its items. */
export function buildClaimInboxPage(overrides: Partial<ClaimInboxPage> = {}): ClaimInboxPage {
  const items = overrides.items ?? [buildClaimInboxItem()];
  return {
    version: 1,
    walletAddress: FIXTURE_WALLET,
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

/** Build a projection state for an arena that has observed no events yet. */
export function buildArenaProjectionState(
  arenaId: string = FIXTURE_CONTRACT_ID,
  overrides: Partial<ArenaProjectionState> = {},
): ArenaProjectionState {
  return { ...initialArenaProjection(arenaId), ...overrides };
}

/** A minimal event sequence that starts an arena and joins two players. */
export function buildArenaEventSequence(
  arenaId: string = FIXTURE_CONTRACT_ID,
): ArenaProjectionEvent[] {
  const base = {
    contractId: arenaId,
    ledgerSequence: 100,
    ledgerClosedAt: "2024-11-14T22:13:20Z",
  };
  return [
    { ...base, id: "e1", txHash: FIXTURE_TX_HASH, topic: "INIT", admin: FIXTURE_WALLET },
    { ...base, id: "e2", ledgerSequence: 101, txHash: FIXTURE_TX_HASH, topic: "CFGD" },
    {
      ...base,
      id: "e3",
      ledgerSequence: 102,
      txHash: FIXTURE_TX_HASH,
      topic: "START",
      commitDeadline: 1_700_000_300,
      revealDeadline: 1_700_000_600,
    },
    { ...base, id: "e4", ledgerSequence: 103, txHash: FIXTURE_TX_HASH, topic: "JOIN", player: FIXTURE_WALLET },
  ];
}

// ─── Invalid-state helpers ──────────────────────────────────────────────────

/** A `RoundInput` that fails `RoundInputSchema`: no players and a bad contract id. */
export function invalidRoundInput(): RoundInput {
  return buildRoundInput({ playerChoices: [], allActivePlayerIds: [], arenaContractId: "not-a-contract" });
}

/** The wire form of {@link invalidRoundInput}, rejected by `RoundInputSchema`. */
export function invalidRoundInputPayload(): Record<string, unknown> {
  return buildRoundInputPayload({ playerChoices: [], allActivePlayerIds: [], arenaContractId: "not-a-contract" });
}

/** A proof bundle claiming a future schema version the backend cannot produce. */
export function invalidRoundProofBundle(): RoundProofBundle {
  return buildRoundProofBundle({ version: 2 as unknown as 1 });
}

/**
 * A claim-inbox page that fails `ClaimInboxPageSchema`: version 2 and a
 * non-numeric stroop amount.
 */
export function invalidClaimInboxPage(): ClaimInboxPage {
  return buildClaimInboxPage({
    version: 2 as unknown as 1,
    items: [buildClaimInboxItem({ components: [buildClaimInboxComponent({ amountStroops: "not-a-number" })] })],
  });
}

/**
 * A projection state that violates the commit/reveal ordering invariant: the
 * commit deadline is after the reveal deadline.
 */
export function invalidArenaProjectionState(
  arenaId: string = FIXTURE_CONTRACT_ID,
): ArenaProjectionState {
  return buildArenaProjectionState(arenaId, {
    commitDeadline: 1_700_000_600,
    revealDeadline: 1_700_000_300,
  });
}

// ─── Structured build telemetry ─────────────────────────────────────────────

/** One structured fixture-build event, mirroring the repo's JSON-line logging. */
export interface FixtureBuildEvent {
  event: "fixture_build";
  kind: string;
  outcome: "success" | "failure";
  latencyMs: number;
}

/**
 * Run a builder and emit one structured `fixture_build` JSON line
 * (success/failure + latency). Injectable `sink` keeps it silent in tests that
 * do not assert on it, and observable in the cross-module integration flow.
 */
export function buildWithTelemetry<T>(
  kind: string,
  builder: () => T,
  sink: (line: string) => void = () => undefined,
): T {
  const startedAt = Date.now();
  try {
    const value = builder();
    const event: FixtureBuildEvent = {
      event: "fixture_build",
      kind,
      outcome: "success",
      latencyMs: Date.now() - startedAt,
    };
    sink(JSON.stringify(event));
    return value;
  } catch (error) {
    const event: FixtureBuildEvent = {
      event: "fixture_build",
      kind,
      outcome: "failure",
      latencyMs: Date.now() - startedAt,
    };
    sink(JSON.stringify(event));
    throw error;
  }
}
