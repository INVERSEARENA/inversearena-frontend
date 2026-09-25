/**
 * The core acceptance criterion for #1382: a projection rebuilt from a
 * checkpoint must match a projection produced from genesis, for the same
 * event sequence.
 *
 * This test builds a projection two ways from an identical 12-event
 * sequence:
 *   (A) genesis replay — fold all 12 events in one pass from
 *       `initialArenaProjection`.
 *   (B) checkpoint replay — fold a PREFIX of the events from genesis,
 *       serialize that state through JSON (simulating what actually
 *       happens when it round-trips through the `projectionState` JSONB
 *       column), then fold the REMAINING SUFFIX from that deserialized
 *       state.
 *
 * It asserts full deep equality (`toEqual`) between (A) and (B) — not just
 * the "visible" fields, but the internal `appliedEventIds`/
 * `skippedEventIds` bookkeeping too — for every possible split point across
 * the sequence (0..12), including the two degenerate splits (split at 0 =
 * pure checkpoint replay from an empty checkpoint; split at length = pure
 * genesis replay, trivially equal to itself).
 */

import {
  foldArenaProjectionEvents,
  initialArenaProjection,
  type ArenaProjectionState,
} from "../src/services/projection/arenaProjectionFold";
import type { ArenaProjectionEvent } from "../src/services/projection/arenaEventTypes";

const ARENA_ID = "CEQUIV0000000000000000000000000000000000000000000000";

function buildEventSequence(): ArenaProjectionEvent[] {
  const mk = (id: string, ledger: number, rest: Record<string, unknown>): ArenaProjectionEvent =>
    ({
      id,
      contractId: ARENA_ID,
      ledgerSequence: ledger,
      ledgerClosedAt: new Date(2026, 0, 1, 0, 0, ledger).toISOString(),
      txHash: `tx-${id}`,
      ...rest,
    }) as ArenaProjectionEvent;

  return [
    mk("e1", 100, { topic: "INIT", admin: "GADMIN" }),
    mk("e2", 101, { topic: "JOIN", player: "GPLAYER1" }),
    mk("e3", 102, { topic: "JOIN", player: "GPLAYER2" }),
    mk("e4", 103, { topic: "JOIN", player: "GPLAYER3" }),
    mk("e5", 104, { topic: "START" }),
    mk("e6", 105, { topic: "CHOICE", player: "GPLAYER1" }),
    mk("e7", 106, { topic: "CHOICE", player: "GPLAYER2" }),
    // A malformed/unknown event in the middle of the stream, to prove the
    // equivalence claim survives skip bookkeeping too, not just happy-path events.
    mk("e8", 106, { topic: "UNKNOWN", rawTopic: "GLITCH", reason: "corrupt payload" }),
    mk("e9", 107, { topic: "ELIM", player: "GPLAYER3" }),
    mk("e10", 108, { topic: "FINISH" }),
    mk("e11", 109, { topic: "CLAIMED", winner: "GPLAYER1" }),
    mk("e12", 110, { topic: "RWAYLD", amount: "750000" }),
  ];
}

/** Round-trips a projection state through JSON, exactly as the JSONB checkpoint column would. */
function throughJson(state: ArenaProjectionState): ArenaProjectionState {
  return JSON.parse(JSON.stringify(state));
}

describe("Genesis replay vs. checkpoint replay equivalence (#1382 core acceptance criterion)", () => {
  const events = buildEventSequence();

  it("produces identical final projection state for every possible checkpoint split point", () => {
    const genesisFinal = foldArenaProjectionEvents(initialArenaProjection(ARENA_ID), events);

    for (let splitAt = 0; splitAt <= events.length; splitAt++) {
      const prefix = events.slice(0, splitAt);
      const suffix = events.slice(splitAt);

      // (B) Checkpoint replay: fold the prefix from genesis, persist it
      // (simulated via JSON round-trip), then resume folding the suffix
      // from the deserialized checkpoint — exactly what
      // arenaProjectionReplay.ts does across batches via
      // ArenaProjectionCheckpointStore.save/load.
      const checkpointedPrefixState = foldArenaProjectionEvents(
        initialArenaProjection(ARENA_ID),
        prefix,
      );
      const resumedState = throughJson(checkpointedPrefixState);
      const checkpointFinal = foldArenaProjectionEvents(resumedState, suffix);

      expect(checkpointFinal).toEqual(genesisFinal);
    }
  });

  it("the equivalence holds field-by-field for a representative mid-stream split (not just as an opaque deep-equal)", () => {
    const splitAt = 6; // after START, before the first CHOICE
    const genesisFinal = foldArenaProjectionEvents(initialArenaProjection(ARENA_ID), events);

    const checkpointedPrefixState = throughJson(
      foldArenaProjectionEvents(initialArenaProjection(ARENA_ID), events.slice(0, splitAt)),
    );
    const checkpointFinal = foldArenaProjectionEvents(
      checkpointedPrefixState,
      events.slice(splitAt),
    );

    expect(checkpointFinal.gameState).toBe(genesisFinal.gameState);
    expect(checkpointFinal.admin).toBe(genesisFinal.admin);
    expect(checkpointFinal.players).toEqual(genesisFinal.players);
    expect(checkpointFinal.choicesSubmitted).toEqual(genesisFinal.choicesSubmitted);
    expect(checkpointFinal.eliminated).toEqual(genesisFinal.eliminated);
    expect(checkpointFinal.winner).toBe(genesisFinal.winner);
    expect(checkpointFinal.prizeClaimed).toBe(genesisFinal.prizeClaimed);
    expect(checkpointFinal.totalYieldStroops).toBe(genesisFinal.totalYieldStroops);
    expect(checkpointFinal.lastLedgerSequence).toBe(genesisFinal.lastLedgerSequence);
    expect(checkpointFinal.lastEventId).toBe(genesisFinal.lastEventId);
    expect(checkpointFinal.appliedEventIds).toEqual(genesisFinal.appliedEventIds);
    expect(checkpointFinal.skippedEventIds).toEqual(genesisFinal.skippedEventIds);
  });

  it("stays equivalent even if the checkpoint-resumed replay redundantly re-delivers the last prefix event (at-least-once semantics)", () => {
    const splitAt = 4;
    const genesisFinal = foldArenaProjectionEvents(initialArenaProjection(ARENA_ID), events);

    const prefix = events.slice(0, splitAt);
    const overlappingSuffix = [events[splitAt - 1] as ArenaProjectionEvent, ...events.slice(splitAt)];

    const checkpointedPrefixState = throughJson(
      foldArenaProjectionEvents(initialArenaProjection(ARENA_ID), prefix),
    );
    const checkpointFinal = foldArenaProjectionEvents(checkpointedPrefixState, overlappingSuffix);

    // Idempotent fold means the redundant redelivery is a no-op — equivalence still holds.
    expect(checkpointFinal).toEqual(genesisFinal);
  });

  it("multi-checkpoint replay (three separate batches, each round-tripped through JSON) still matches genesis", () => {
    const genesisFinal = foldArenaProjectionEvents(initialArenaProjection(ARENA_ID), events);

    const batch1 = events.slice(0, 3);
    const batch2 = events.slice(3, 8);
    const batch3 = events.slice(8);

    let state = throughJson(foldArenaProjectionEvents(initialArenaProjection(ARENA_ID), batch1));
    state = throughJson(foldArenaProjectionEvents(state, batch2));
    state = foldArenaProjectionEvents(state, batch3);

    expect(state).toEqual(genesisFinal);
  });
});
