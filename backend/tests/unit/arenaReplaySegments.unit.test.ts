import {
  buildReplayCheckpoints,
  buildReplaySegment,
  projectionAtCount,
  ReplayCursorNotFoundError,
  REPLAY_SEGMENT_MAX_EVENTS,
  toPublicReplayEvent,
  verifyReplaySegment,
} from "../../src/domain/arenaReplaySegments";
import { foldArenaProjectionEvents, initialArenaProjection } from "../../src/services/projection/arenaProjectionFold";
import type { ArenaProjectionEvent } from "../../src/services/projection/arenaEventTypes";

const ARENA_ID = "CARENA0000000000000000000000000000000000000000000000";
const PLAYER_A = "GPLAYERA";
const PLAYER_B = "GPLAYERB";

function base(id: string, ledger: number) {
  return {
    id,
    contractId: ARENA_ID,
    ledgerSequence: ledger,
    ledgerClosedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ledger)).toISOString(),
    txHash: `tx-${id}`,
  };
}

/** A realistic ordered log: init, configure, two joins, a choice, a start, an elimination, a yield, a finish, a claim. */
function sampleLog(): ArenaProjectionEvent[] {
  return [
    { ...base("e1", 10), topic: "INIT", admin: "GADMIN" },
    { ...base("e2", 11), topic: "CFGD" },
    { ...base("e3", 12), topic: "JOIN", player: PLAYER_A },
    { ...base("e4", 12), topic: "JOIN", player: PLAYER_B },
    { ...base("e5", 13), topic: "START" },
    { ...base("e6", 14), topic: "CHOICE", player: PLAYER_A },
    { ...base("e7", 15), topic: "ELIM", player: PLAYER_B },
    { ...base("e8", 15), topic: "RWAYLD", amount: "5000000" },
    { ...base("e9", 16), topic: "FINISH" },
    { ...base("e10", 17), topic: "CLAIMED", winner: PLAYER_A },
  ];
}

describe("toPublicReplayEvent", () => {
  it("never exposes unrevealed choices or unknown events", () => {
    const [, , , , , choice] = sampleLog();
    expect(toPublicReplayEvent(choice)).toBeNull();
    expect(
      toPublicReplayEvent({ ...base("u1", 1), topic: "UNKNOWN", rawTopic: "X", reason: "unrecognised" }),
    ).toBeNull();
  });

  it("maps subjects and amounts per topic", () => {
    const log = sampleLog();
    expect(toPublicReplayEvent(log[2])).toMatchObject({ type: "player_joined", subject: PLAYER_A, amountStroops: null });
    expect(toPublicReplayEvent(log[7])).toMatchObject({ type: "yield_received", subject: null, amountStroops: "5000000" });
    expect(toPublicReplayEvent(log[9])).toMatchObject({ type: "prize_claimed", subject: PLAYER_A });
  });
});

describe("buildReplayCheckpoints and projectionAtCount", () => {
  it("seeking from a checkpoint equals folding from genesis at every boundary", () => {
    const log = sampleLog();
    const checkpoints = buildReplayCheckpoints(ARENA_ID, log, 3);
    for (let count = 0; count <= log.length; count++) {
      const fromGenesis = foldArenaProjectionEvents(initialArenaProjection(ARENA_ID), log.slice(0, count));
      expect(projectionAtCount(ARENA_ID, log, count, checkpoints)).toEqual(fromGenesis);
    }
  });

  it("rejects a log that is out of ledger order", () => {
    const log = sampleLog();
    const reordered = [log[0], { ...log[1], ledgerSequence: 1 }];
    expect(() => buildReplayCheckpoints(ARENA_ID, reordered)).toThrow(/out of ledger order/);
  });

  it("rejects a non-positive checkpoint interval", () => {
    expect(() => buildReplayCheckpoints(ARENA_ID, sampleLog(), 0)).toThrow(RangeError);
  });
});

describe("buildReplaySegment", () => {
  it("pages through the whole log without dropping or repeating events", () => {
    const log = sampleLog();
    const checkpoints = buildReplayCheckpoints(ARENA_ID, log, 4);
    const seen: string[] = [];
    let after: string | null = null;
    let hasMore = true;
    while (hasMore) {
      const segment = buildReplaySegment({ arenaId: ARENA_ID, contractVersion: 3, events: log, checkpoints, afterCursor: after, limit: 3 });
      seen.push(...segment.events.map((event) => event.cursor));
      hasMore = segment.hasMore;
      after = segment.nextCursor;
    }
    // Every public event appears exactly once, in log order.
    expect(seen).toEqual(["e1", "e2", "e3", "e4", "e5", "e7", "e8", "e9", "e10"]);
  });

  it("advances the cursor even when a whole page is private", () => {
    const log = sampleLog();
    const checkpoints = buildReplayCheckpoints(ARENA_ID, log);
    const segment = buildReplaySegment({ arenaId: ARENA_ID, contractVersion: 3, events: log, checkpoints, afterCursor: "e5", limit: 1 });
    expect(segment.events).toEqual([]);
    expect(segment.nextCursor).toBe("e6");
    expect(segment.hasMore).toBe(true);
  });

  it("reports the projection revision at the segment end", () => {
    const log = sampleLog();
    const checkpoints = buildReplayCheckpoints(ARENA_ID, log, 2);
    const segment = buildReplaySegment({ arenaId: ARENA_ID, contractVersion: 3, events: log, checkpoints, afterCursor: null, limit: 4 });
    expect(segment.projectionRevision).toBe("12:e4");
    expect(segment.hasMore).toBe(true);
  });

  it("clamps the requested limit to the maximum", () => {
    const log = sampleLog();
    const segment = buildReplaySegment({
      arenaId: ARENA_ID,
      contractVersion: null,
      events: log,
      checkpoints: buildReplayCheckpoints(ARENA_ID, log),
      afterCursor: null,
      limit: REPLAY_SEGMENT_MAX_EVENTS * 10,
    });
    expect(segment.hasMore).toBe(false);
    expect(segment.nextCursor).toBe("e10");
  });

  it("throws for a cursor that is not part of the arena log", () => {
    const log = sampleLog();
    expect(() =>
      buildReplaySegment({ arenaId: ARENA_ID, contractVersion: 3, events: log, checkpoints: buildReplayCheckpoints(ARENA_ID, log), afterCursor: "missing" }),
    ).toThrow(ReplayCursorNotFoundError);
  });

  it("returns an empty, stable segment for an empty log", () => {
    const segment = buildReplaySegment({ arenaId: ARENA_ID, contractVersion: 3, events: [], checkpoints: buildReplayCheckpoints(ARENA_ID, []), afterCursor: null });
    expect(segment.events).toEqual([]);
    expect(segment.nextCursor).toBeNull();
    expect(segment.projectionRevision).toBe("none:none");
    expect(segment.checksum).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("verifyReplaySegment", () => {
  const log = sampleLog();
  const checkpoints = buildReplayCheckpoints(ARENA_ID, log);
  const first = buildReplaySegment({ arenaId: ARENA_ID, contractVersion: 3, events: log, checkpoints, afterCursor: null, limit: 3 });

  it("accepts a well-formed segment that links to the client cursor", () => {
    expect(verifyReplaySegment(first, { contractVersion: 3, lastCursor: null })).toEqual({ ok: true });
  });

  it("detects a tampered payload", () => {
    const tampered = { ...first, events: [{ ...first.events[0], subject: "GATTACKER" }, ...first.events.slice(1)] };
    expect(verifyReplaySegment(tampered, { contractVersion: 3, lastCursor: null })).toEqual({ ok: false, issue: "checksum_mismatch" });
  });

  it("detects a gap when the segment does not continue from the client cursor", () => {
    expect(verifyReplaySegment(first, { contractVersion: 3, lastCursor: "e2" })).toEqual({ ok: false, issue: "cursor_gap" });
  });

  it("detects a contract version mismatch", () => {
    expect(verifyReplaySegment(first, { contractVersion: 4, lastCursor: null })).toEqual({
      ok: false,
      issue: "contract_version_mismatch",
    });
  });

  it("detects a format version mismatch", () => {
    const future = { ...first, version: 2 } as never;
    expect(verifyReplaySegment(future, { contractVersion: 3, lastCursor: null })).toEqual({
      ok: false,
      issue: "format_version_mismatch",
    });
  });
});
