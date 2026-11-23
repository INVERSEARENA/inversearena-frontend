import { describe, expect, it } from "@jest/globals";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  buildArenaDisplayState,
  parseArenaStateFromScVal,
  parseUserStateFromScVal,
} from "../contract-state-parsers";

function symbolMap(
  entries: Array<[string, ReturnType<typeof nativeToScVal>]>,
): xdr.ScVal {
  return xdr.ScVal.scvMap(
    entries.map(([key, value]) =>
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol(key),
        val: value,
      }),
    ),
  );
}

describe("contract-state-parsers", () => {
  it("parses arena state into explicit TypeScript types", () => {
    const stateData = symbolMap([
      ["survivors_count", nativeToScVal(7, { type: "u32" })],
      ["max_capacity", nativeToScVal(16, { type: "u32" })],
      ["round_number", nativeToScVal(3, { type: "u32" })],
      ["current_stake", nativeToScVal(12_000_000n, { type: "i128" })],
      ["potential_payout", nativeToScVal(48_500_000n, { type: "i128" })],
    ]);

    const arenaState = parseArenaStateFromScVal(stateData);

    expect(arenaState).toEqual({
      survivors: 7,
      capacity: 16,
      round: 3,
      stakes: 12_000_000n,
      payouts: 48_500_000n,
    });
  });

  it("parses user state into explicit TypeScript types", () => {
    const userData = symbolMap([
      ["is_active", xdr.ScVal.scvBool(true)],
      ["has_won", xdr.ScVal.scvBool(false)],
    ]);

    expect(parseUserStateFromScVal(userData)).toEqual({
      active: true,
      won: false,
    });
  });

  it("builds backwards-compatible display values from typed arena state", () => {
    const displayState = buildArenaDisplayState({
      survivors: 5,
      capacity: 12,
      round: 4,
      stakes: 25_000_000n,
      payouts: 100_000_000n,
    });

    expect(displayState).toEqual({
      survivorsCount: 5,
      maxCapacity: 12,
      currentStake: 2.5,
      potentialPayout: 10,
      roundNumber: 4,
      currentStakeStroops: 25_000_000n,
      potentialPayoutStroops: 100_000_000n,
    });
  });
});
