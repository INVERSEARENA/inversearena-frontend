import { describe, expect, it } from "@jest/globals";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { parsePlayerStatusFromScVal } from "../contract-state-parsers";

function unitVariant(name: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]);
}

/** Encodes a `PlayerStatus` the way `#[contracttype]` does: a symbol-keyed map. */
function playerStatusScVal(overrides: Record<string, xdr.ScVal> = {}): xdr.ScVal {
  const fields: Record<string, xdr.ScVal> = {
    active: nativeToScVal(false),
    committed: nativeToScVal(false),
    current_round: nativeToScVal(2, { type: "u32" }),
    elimination_reason: unitVariant("NoReveal"),
    eliminated_round: nativeToScVal(2, { type: "u32" }),
    joined: nativeToScVal(true),
    phase: unitVariant("Intermission"),
    refund_claimed: nativeToScVal(false),
    revealed: nativeToScVal(false),
    winner: nativeToScVal(false),
    ...overrides,
  };
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key]! })),
  );
}

describe("parsePlayerStatusFromScVal", () => {
  it("decodes every field of an eliminated player", () => {
    expect(parsePlayerStatusFromScVal(playerStatusScVal())).toEqual({
      joined: true,
      active: false,
      committed: false,
      revealed: false,
      eliminatedRound: 2,
      eliminationReason: "NoReveal",
      refundClaimed: false,
      winner: false,
      currentRound: 2,
      phase: "Intermission",
    });
  });

  it("decodes Option::None as a null eliminated round", () => {
    const status = parsePlayerStatusFromScVal(
      playerStatusScVal({
        eliminated_round: xdr.ScVal.scvVoid(),
        elimination_reason: unitVariant("NotEliminated"),
      }),
    );
    expect(status.eliminatedRound).toBeNull();
    expect(status.eliminationReason).toBe("NotEliminated");
  });

  it("rejects an unknown phase instead of guessing", () => {
    expect(() =>
      parsePlayerStatusFromScVal(playerStatusScVal({ phase: unitVariant("Paused") })),
    ).toThrow("unknown variant Paused");
  });

  it("rejects a missing field", () => {
    const missingWinner = xdr.ScVal.scvMap(
      (playerStatusScVal().map() ?? []).filter(
        (entry) => entry.key().sym().toString() !== "winner",
      ),
    );
    expect(() => parsePlayerStatusFromScVal(missingWinner)).toThrow("winner is not a bool");
  });

  it("rejects a non-struct value", () => {
    expect(() => parsePlayerStatusFromScVal(nativeToScVal(1, { type: "u32" }))).toThrow(
      "did not return a struct",
    );
  });
});
