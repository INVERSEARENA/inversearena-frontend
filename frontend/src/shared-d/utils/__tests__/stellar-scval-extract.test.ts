import { describe, it, expect } from "@jest/globals";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  extractBoolFromScVal,
  extractI128FromScVal,
  extractU32FromScVal,
} from "../stellar-scval-extract";

describe("stellar-scval-extract", () => {
  it("extractU32FromScVal reads plain u32", () => {
    const v = nativeToScVal(7, { type: "u32" });
    expect(extractU32FromScVal(v)).toBe(7);
  });

  it("extractBoolFromScVal reads bool", () => {
    const v = xdr.ScVal.scvBool(true);
    expect(extractBoolFromScVal(v)).toBe(true);
  });

  it("extractI128FromScVal reads i128 stroops-style magnitude", () => {
    const v = nativeToScVal(10_000_000n, { type: "i128" });
    expect(extractI128FromScVal(v)).toBe(1);
  });
});
