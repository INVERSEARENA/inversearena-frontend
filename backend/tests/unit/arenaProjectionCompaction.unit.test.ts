import { describe, expect, it } from "@jest/globals";
import {
  compactArenaProjectionState,
  hasValidProjectionHistoryAnchor,
  initialArenaProjection,
} from "../../src/services/projection/arenaProjectionFold";

describe("arena projection history compaction", () => {
  it("prunes only event ids below the active verified-ledger retention floor", () => {
    const state = {
      ...initialArenaProjection("arena"),
      lastLedgerSequence: 10_000,
      lastEventId: "recent",
      appliedEventIds: ["old", "recent"],
      skippedEventIds: ["old-skipped"],
      eventLedgerSequences: {
        old: 0,
        recent: 9_999,
        "old-skipped": 0,
      },
    };

    const compacted = compactArenaProjectionState(state);

    expect(compacted.appliedEventIds).toEqual(["recent"]);
    expect(compacted.skippedEventIds).toEqual([]);
    expect(compacted.historyAnchor?.compactedThroughLedger).toBe(0);
    expect(hasValidProjectionHistoryAnchor(compacted)).toBe(true);
    expect(hasValidProjectionHistoryAnchor({ ...compacted, players: ["tampered"] })).toBe(false);
  });

  it("uses a shorter retention window after an arena reaches a terminal state", () => {
    const state = {
      ...initialArenaProjection("arena"),
      lastLedgerSequence: 10_000,
      gameState: "finished" as const,
      appliedEventIds: ["prior", "recent"],
      eventLedgerSequences: { prior: 9_000, recent: 9_999 },
    };

    const compacted = compactArenaProjectionState(state);

    expect(compacted.appliedEventIds).toEqual(["recent"]);
    expect(compacted.historyAnchor?.compactedThroughLedger).toBe(9_744);
  });

  it("retains legacy ids whose exact ledger is not known", () => {
    const state = {
      ...initialArenaProjection("arena"),
      lastLedgerSequence: 10_000,
      appliedEventIds: ["legacy"],
    };

    expect(compactArenaProjectionState(state).appliedEventIds).toEqual(["legacy"]);
  });
});
