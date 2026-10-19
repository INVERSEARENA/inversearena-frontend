import {
  foldArenaProjectionEvent,
  foldArenaProjectionEvents,
  initialArenaProjection,
  type ArenaProjectionState,
} from "../src/services/projection/arenaProjectionFold";
import type { ArenaProjectionEvent } from "../src/services/projection/arenaEventTypes";

const ARENA_ID = "CARENA0000000000000000000000000000000000000000000000";

function ev<T extends ArenaProjectionEvent>(partial: T): T {
  return partial;
}

function initEvent(id: string, ledger: number, admin = "GADMIN"): ArenaProjectionEvent {
  return ev({
    id,
    contractId: ARENA_ID,
    ledgerSequence: ledger,
    ledgerClosedAt: new Date(2026, 0, 1, 0, 0, ledger).toISOString(),
    txHash: `tx-${id}`,
    topic: "INIT",
    admin,
  });
}

function joinEvent(id: string, ledger: number, player: string): ArenaProjectionEvent {
  return ev({
    id,
    contractId: ARENA_ID,
    ledgerSequence: ledger,
    ledgerClosedAt: new Date(2026, 0, 1, 0, 0, ledger).toISOString(),
    txHash: `tx-${id}`,
    topic: "JOIN",
    player,
  });
}

function choiceEvent(id: string, ledger: number, player: string): ArenaProjectionEvent {
  return ev({
    id,
    contractId: ARENA_ID,
    ledgerSequence: ledger,
    ledgerClosedAt: new Date(2026, 0, 1, 0, 0, ledger).toISOString(),
    txHash: `tx-${id}`,
    topic: "CHOICE",
    player,
  });
}

function elimEvent(id: string, ledger: number, player: string): ArenaProjectionEvent {
  return ev({
    id,
    contractId: ARENA_ID,
    ledgerSequence: ledger,
    ledgerClosedAt: new Date(2026, 0, 1, 0, 0, ledger).toISOString(),
    txHash: `tx-${id}`,
    topic: "ELIM",
    player,
  });
}

function startEvent(id: string, ledger: number): ArenaProjectionEvent {
  return ev({
    id,
    contractId: ARENA_ID,
    ledgerSequence: ledger,
    ledgerClosedAt: new Date(2026, 0, 1, 0, 0, ledger).toISOString(),
    txHash: `tx-${id}`,
    topic: "START",
  });
}

function finishEvent(id: string, ledger: number): ArenaProjectionEvent {
  return ev({
    id,
    contractId: ARENA_ID,
    ledgerSequence: ledger,
    ledgerClosedAt: new Date(2026, 0, 1, 0, 0, ledger).toISOString(),
    txHash: `tx-${id}`,
    topic: "FINISH",
  });
}

function claimedEvent(id: string, ledger: number, winner: string): ArenaProjectionEvent {
  return ev({
    id,
    contractId: ARENA_ID,
    ledgerSequence: ledger,
    ledgerClosedAt: new Date(2026, 0, 1, 0, 0, ledger).toISOString(),
    txHash: `tx-${id}`,
    topic: "CLAIMED",
    winner,
  });
}

function yieldEvent(id: string, ledger: number, amount: string): ArenaProjectionEvent {
  return ev({
    id,
    contractId: ARENA_ID,
    ledgerSequence: ledger,
    ledgerClosedAt: new Date(2026, 0, 1, 0, 0, ledger).toISOString(),
    txHash: `tx-${id}`,
    topic: "RWAYLD",
    amount,
  });
}

function unknownEvent(id: string, ledger: number): ArenaProjectionEvent {
  return ev({
    id,
    contractId: ARENA_ID,
    ledgerSequence: ledger,
    ledgerClosedAt: new Date(2026, 0, 1, 0, 0, ledger).toISOString(),
    txHash: `tx-${id}`,
    topic: "UNKNOWN",
    rawTopic: "WEIRD",
    reason: "test-injected unknown topic",
  });
}

describe("initialArenaProjection", () => {
  it("returns a well-formed empty projection", () => {
    const state = initialArenaProjection(ARENA_ID);
    expect(state).toEqual<ArenaProjectionState>({
      arenaId: ARENA_ID,
      lastLedgerSequence: null,
      lastEventId: null,
      gameState: "unknown",
      admin: null,
      players: [],
      choicesSubmitted: [],
      eliminated: [],
      winner: null,
      prizeClaimed: false,
      totalYieldStroops: "0",
      appliedEventIds: [],
      skippedEventIds: [],
    });
  });
});

describe("foldArenaProjectionEvents — normal sequences", () => {
  it("folds an empty event list into an unchanged state", () => {
    const state = initialArenaProjection(ARENA_ID);
    const result = foldArenaProjectionEvents(state, []);
    expect(result).toEqual(state);
  });

  it("folds a full lifecycle: init → join x2 → start → choice x2 → elim → finish → claim → yield", () => {
    const events: ArenaProjectionEvent[] = [
      initEvent("e1", 100, "GADMIN"),
      joinEvent("e2", 101, "GPLAYER1"),
      joinEvent("e3", 102, "GPLAYER2"),
      startEvent("e4", 103),
      choiceEvent("e5", 104, "GPLAYER1"),
      choiceEvent("e6", 105, "GPLAYER2"),
      elimEvent("e7", 106, "GPLAYER2"),
      finishEvent("e8", 107),
      claimedEvent("e9", 108, "GPLAYER1"),
      yieldEvent("e10", 109, "500000"),
    ];

    const result = foldArenaProjectionEvents(initialArenaProjection(ARENA_ID), events);

    expect(result.gameState).toBe("finished");
    expect(result.admin).toBe("GADMIN");
    expect(result.players).toEqual(["GPLAYER1", "GPLAYER2"]);
    expect(result.eliminated).toEqual(["GPLAYER2"]);
    // ELIM clears choicesSubmitted for the round it resolves.
    expect(result.choicesSubmitted).toEqual([]);
    expect(result.winner).toBe("GPLAYER1");
    expect(result.prizeClaimed).toBe(true);
    expect(result.totalYieldStroops).toBe("500000");
    expect(result.lastLedgerSequence).toBe(109);
    expect(result.lastEventId).toBe("e10");
    expect(result.appliedEventIds).toEqual([
      "e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10",
    ]);
    expect(result.skippedEventIds).toEqual([]);
  });

  it("accumulates RWAYLD amounts with bigint precision across multiple events", () => {
    const events: ArenaProjectionEvent[] = [
      yieldEvent("y1", 1, "9007199254740993"), // beyond Number.MAX_SAFE_INTEGER
      yieldEvent("y2", 2, "1"),
    ];
    const result = foldArenaProjectionEvents(initialArenaProjection(ARENA_ID), events);
    expect(result.totalYieldStroops).toBe("9007199254740994");
  });

  it("appendUnique does not duplicate a player who joins twice with different event ids", () => {
    const events: ArenaProjectionEvent[] = [
      joinEvent("j1", 1, "GPLAYER1"),
      joinEvent("j2", 2, "GPLAYER1"),
    ];
    const result = foldArenaProjectionEvents(initialArenaProjection(ARENA_ID), events);
    expect(result.players).toEqual(["GPLAYER1"]);
    // Both distinct event ids were still applied (idempotency is per event id, not per effect).
    expect(result.appliedEventIds).toEqual(["j1", "j2"]);
  });
});

describe("foldArenaProjectionEvent — boundary conditions", () => {
  it("skips an out-of-order event (ledger behind the current watermark) rather than reordering history", () => {
    let state = initialArenaProjection(ARENA_ID);
    state = foldArenaProjectionEvent(state, joinEvent("j1", 100, "GPLAYER1"));
    expect(state.lastLedgerSequence).toBe(100);

    const staleEvent = joinEvent("j0", 50, "GPLAYER2");
    const result = foldArenaProjectionEvent(state, staleEvent);

    expect(result.players).toEqual(["GPLAYER1"]); // stale join never applied
    expect(result.skippedEventIds).toEqual(["j0"]);
    expect(result.lastLedgerSequence).toBe(100); // watermark unchanged by a skip
  });

  it("treats an unknown/malformed event as a recorded skip, not a throw", () => {
    const state = initialArenaProjection(ARENA_ID);
    expect(() =>
      foldArenaProjectionEvent(state, unknownEvent("u1", 1)),
    ).not.toThrow();

    const result = foldArenaProjectionEvent(state, unknownEvent("u1", 1));
    expect(result.skippedEventIds).toEqual(["u1"]);
    expect(result.lastLedgerSequence).toBe(1); // watermark still advances past a skip
    expect(result.gameState).toBe("unknown"); // interpreted state untouched
  });

  it("CFGD is applied (advances lastEventId) without altering interpreted state", () => {
    const state = foldArenaProjectionEvent(initialArenaProjection(ARENA_ID), {
      id: "c1",
      contractId: ARENA_ID,
      ledgerSequence: 5,
      ledgerClosedAt: new Date().toISOString(),
      txHash: "tx-c1",
      topic: "CFGD",
    });
    expect(state.lastEventId).toBe("c1");
    expect(state.appliedEventIds).toEqual(["c1"]);
    expect(state.gameState).toBe("unknown");
  });

  it("an event at exactly the current watermark ledger is still applied (not treated as stale)", () => {
    let state = initialArenaProjection(ARENA_ID);
    state = foldArenaProjectionEvent(state, joinEvent("j1", 100, "GPLAYER1"));
    // Same-ledger event (two events can land in one ledger) must still fold.
    state = foldArenaProjectionEvent(state, joinEvent("j2", 100, "GPLAYER2"));
    expect(state.players).toEqual(["GPLAYER1", "GPLAYER2"]);
    expect(state.skippedEventIds).toEqual([]);
  });
});

describe("foldArenaProjectionEvent — duplicate delivery / idempotency", () => {
  it("folding the exact same event twice is a no-op the second time", () => {
    const state = initialArenaProjection(ARENA_ID);
    const once = foldArenaProjectionEvent(state, joinEvent("j1", 10, "GPLAYER1"));
    const twice = foldArenaProjectionEvent(once, joinEvent("j1", 10, "GPLAYER1"));

    expect(twice).toEqual(once);
    expect(twice.players).toEqual(["GPLAYER1"]);
    expect(twice.appliedEventIds).toEqual(["j1"]);
  });

  it("does not double-count RWAYLD amount on duplicate delivery", () => {
    const state = initialArenaProjection(ARENA_ID);
    const events = [yieldEvent("y1", 1, "1000"), yieldEvent("y1", 1, "1000")];
    const result = foldArenaProjectionEvents(state, events);
    expect(result.totalYieldStroops).toBe("1000");
  });

  it("re-applying a previously-skipped unknown event id is also a no-op", () => {
    const state = initialArenaProjection(ARENA_ID);
    const once = foldArenaProjectionEvent(state, unknownEvent("u1", 1));
    const twice = foldArenaProjectionEvent(once, unknownEvent("u1", 1));
    expect(twice.skippedEventIds).toEqual(["u1"]);
  });

  it("is idempotent under an entire batch replayed twice back-to-back (retry-safe)", () => {
    const events: ArenaProjectionEvent[] = [
      initEvent("e1", 1, "GADMIN"),
      joinEvent("e2", 2, "GPLAYER1"),
      elimEvent("e3", 3, "GPLAYER1"),
    ];
    const once = foldArenaProjectionEvents(initialArenaProjection(ARENA_ID), events);
    const retried = foldArenaProjectionEvents(once, events); // simulate a retried delivery of the same batch
    expect(retried).toEqual(once);
  });
});

describe("foldArenaProjectionEvent — invalid input paths", () => {
  it("never throws regardless of event shape (UNKNOWN is the escape hatch)", () => {
    const state = initialArenaProjection(ARENA_ID);
    const weird = unknownEvent("w1", 1);
    expect(() => foldArenaProjectionEvent(state, weird)).not.toThrow();
  });

  it("a run of only unknown events leaves the projection state semantically empty but advances the watermark", () => {
    const events: ArenaProjectionEvent[] = [
      unknownEvent("u1", 1),
      unknownEvent("u2", 2),
      unknownEvent("u3", 3),
    ];
    const result = foldArenaProjectionEvents(initialArenaProjection(ARENA_ID), events);
    expect(result.gameState).toBe("unknown");
    expect(result.players).toEqual([]);
    expect(result.skippedEventIds).toEqual(["u1", "u2", "u3"]);
    expect(result.lastLedgerSequence).toBe(3);
    expect(result.lastEventId).toBeNull(); // no *applied* event yet
  });
});
