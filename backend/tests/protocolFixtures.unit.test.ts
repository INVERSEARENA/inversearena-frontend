/**
 * Tests for the repository-wide protocol fixture builders (#1464).
 *
 * Covers the four required paths — normal, boundary, retry/idempotency, and
 * invalid input — plus one cross-module flow that folds the fixture event
 * sequence through the projection and derives a round phase from it.
 */
import { test } from "node:test";
import assert from "node:assert";

import {
  FIXTURE_CONTRACT_ID,
  FIXTURE_UUID,
  buildArenaEventSequence,
  buildArenaProjectionState,
  buildClaimInboxComponent,
  buildClaimInboxItem,
  buildClaimInboxPage,
  buildCommitReceipt,
  buildMoney,
  buildPayout,
  buildRoundData,
  buildRoundInput,
  buildRoundInputPayload,
  buildRoundProofBundle,
  buildWithTelemetry,
  invalidArenaProjectionState,
  invalidClaimInboxPage,
  invalidRoundInput,
  invalidRoundInputPayload,
  invalidRoundProofBundle,
} from "./helpers/protocolFixtures";
import { RoundInputSchema, ROUND_PROOF_BUNDLE_VERSION } from "../src/types/round";
import { ClaimInboxPageSchema } from "../src/types/claimInbox";
import {
  foldArenaProjectionEvents,
  projectArenaPhase,
} from "../src/services/projection/arenaProjectionFold";

test("normal: builders produce schema-valid protocol objects", () => {
  assert.equal(RoundInputSchema.safeParse(buildRoundInputPayload()).success, true);
  assert.equal(ClaimInboxPageSchema.safeParse(buildClaimInboxPage()).success, true);
  assert.equal(buildRoundProofBundle().version, ROUND_PROOF_BUNDLE_VERSION);
  assert.equal(buildMoney(42n).atomicAmount, 42n);
  assert.equal(buildCommitReceipt().status, "accepted");
  assert.equal(buildRoundInput().playerChoices.length, 1);
});

test("normal: settlement breakdown is internally consistent", () => {
  const payout = buildPayout();
  const expectedGross = payout.amount.atomicAmount + payout.platformFee.atomicAmount + payout.dust.atomicAmount;
  assert.equal(payout.principal.atomicAmount + payout.yieldAmount.atomicAmount, expectedGross);
});

test("boundary: claim inbox summary is derived from items", () => {
  const page = buildClaimInboxPage({
    items: [
      buildClaimInboxItem({ id: "a", state: "actionable" }),
      buildClaimInboxItem({ id: "b", state: "completed" }),
      buildClaimInboxItem({ id: "c", state: "completed" }),
    ],
  });
  assert.equal(page.summary.actionable, 1);
  assert.equal(page.summary.completed, 2);
  assert.equal(page.summary.total, 3);
  assert.equal(ClaimInboxPageSchema.safeParse(page).success, true);
});

test("boundary: an empty inbox page is valid", () => {
  const page = buildClaimInboxPage({ items: [] });
  assert.equal(page.summary.total, 0);
  assert.equal(ClaimInboxPageSchema.safeParse(page).success, true);
});

test("retry: repeated builds are deeply equal and independent", () => {
  assert.deepStrictEqual(buildRoundInput(), buildRoundInput());
  assert.deepStrictEqual(buildRoundProofBundle(), buildRoundProofBundle());
  assert.deepStrictEqual(buildRoundData(), buildRoundData());

  const first = buildClaimInboxComponent();
  first.amountStroops = "0";
  assert.notEqual(buildClaimInboxComponent().amountStroops, "0");
});

test("retry: re-folding the same events is idempotent", () => {
  const events = buildArenaEventSequence();
  const once = foldArenaProjectionEvents(buildArenaProjectionState(), events);
  const twice = foldArenaProjectionEvents(once, events);
  assert.deepStrictEqual(twice, once);
});

test("invalid: malformed fixtures are rejected at their schema boundary", () => {
  assert.equal(RoundInputSchema.safeParse(invalidRoundInputPayload()).success, false);
  assert.equal(ClaimInboxPageSchema.safeParse(invalidClaimInboxPage()).success, false);
  assert.equal(invalidRoundInput().playerChoices.length, 0);
  assert.notEqual(invalidRoundProofBundle().version, ROUND_PROOF_BUNDLE_VERSION);
});

test("invalid: projection state can violate the deadline ordering invariant", () => {
  const bad = invalidArenaProjectionState();
  assert.ok(bad.commitDeadline !== null && bad.revealDeadline !== null);
  assert.ok(bad.commitDeadline > bad.revealDeadline);
});

test("integration: fixture event sequence folds into a phase-bearing projection", () => {
  const projection = foldArenaProjectionEvents(buildArenaProjectionState(), buildArenaEventSequence());
  assert.equal(projection.arenaId, FIXTURE_CONTRACT_ID);
  assert.equal(projection.players.length, 1);
  assert.equal(projection.gameState, "in_progress");

  const commit = projectArenaPhase(projection, 1_700_000_100);
  const reveal = projectArenaPhase(projection, 1_700_000_400);
  const resolvable = projectArenaPhase(projection, 1_700_000_700);
  assert.equal(commit, "commit");
  assert.equal(reveal, "reveal");
  assert.equal(resolvable, "resolvable");
});

test("integration: telemetry reports success with latency and surfaces failure", () => {
  const lines: string[] = [];
  const built = buildWithTelemetry("claim-inbox-page", () => buildClaimInboxPage(), (line) =>
    lines.push(line),
  );
  assert.equal(built.items[0]?.arenaId, FIXTURE_CONTRACT_ID);
  const success = JSON.parse(lines[0] ?? "{}");
  assert.equal(success.event, "fixture_build");
  assert.equal(success.outcome, "success");
  assert.equal(typeof success.latencyMs, "number");

  assert.throws(() =>
    buildWithTelemetry("boom", () => {
      throw new Error("builder failed");
    }, (line) => lines.push(line)),
  );
  const failure = JSON.parse(lines[1] ?? "{}");
  assert.equal(failure.outcome, "failure");
});

test("fixture ids are well-formed", () => {
  assert.match(FIXTURE_CONTRACT_ID, /^C[A-Z2-7]{55}$/);
  assert.match(FIXTURE_UUID, /^[0-9a-f-]{36}$/);
});
