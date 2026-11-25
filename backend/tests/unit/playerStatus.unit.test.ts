/**
 * Unit tests for the `get_player_status` decoder (#1582).
 */
import { decodePlayerStatus } from "../../src/services/playerStatus";

/** `scValToNative` output for a `PlayerStatus` struct. */
function rawStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    joined: true,
    active: false,
    committed: false,
    revealed: false,
    eliminated_round: 2,
    elimination_reason: ["Majority"],
    refund_claimed: false,
    winner: false,
    current_round: 3,
    phase: ["Commit"],
    ...overrides,
  };
}

describe("decodePlayerStatus", () => {
  it("decodes every field", () => {
    expect(decodePlayerStatus(rawStatus())).toEqual({
      joined: true,
      active: false,
      committed: false,
      revealed: false,
      eliminatedRound: 2,
      eliminationReason: "Majority",
      refundClaimed: false,
      winner: false,
      currentRound: 3,
      phase: "Commit",
    });
  });

  it("decodes Option::None and accepts bigint integers", () => {
    const status = decodePlayerStatus(
      rawStatus({ eliminated_round: null, current_round: 4n, elimination_reason: ["NotEliminated"] }),
    );
    expect(status.eliminatedRound).toBeNull();
    expect(status.currentRound).toBe(4);
  });

  it("rejects unknown variants, missing fields and non-structs", () => {
    expect(() => decodePlayerStatus(rawStatus({ phase: ["Paused"] }))).toThrow("unknown variant Paused");
    expect(() => decodePlayerStatus(rawStatus({ winner: undefined }))).toThrow("winner is not a bool");
    expect(() => decodePlayerStatus(rawStatus({ current_round: -1 }))).toThrow("current_round is not a u32");
    expect(() => decodePlayerStatus([])).toThrow("not a struct");
  });
});
