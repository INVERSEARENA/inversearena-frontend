import { describe, it, expect } from "@jest/globals";
import { StrKey } from "@stellar/stellar-sdk";
import {
  encodeAddress,
  encodeAmount,
  encodeChoice,
  encodeRound,
} from "../scval-helpers";

/** Valid-format account used elsewhere in this codebase (simulation dummy). */
const SAMPLE_PUBLIC_KEY =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Known contract id format from project defaults (testnet XLM SAC). */
const SAMPLE_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 3));

describe("encodeAmount", () => {
  it("encodes bigint as scvI128", () => {
    const v = encodeAmount(1_000_000n);
    expect(v.switch().name).toBe("scvI128");
  });

  it("encodes integer number as scvI128", () => {
    const v = encodeAmount(42);
    expect(v.switch().name).toBe("scvI128");
  });

  it("rejects non-integer number", () => {
    expect(() => encodeAmount(1.5)).toThrow("finite integer");
  });
});

describe("encodeRound", () => {
  it("encodes u32 values", () => {
    expect(encodeRound(0).switch().name).toBe("scvU32");
    expect(encodeRound(30).u32()).toBe(30);
  });

  it("accepts bigint in u32 range", () => {
    expect(encodeRound(0xffffffffn).u32()).toBe(0xffffffff);
  });

  it("rejects negative round", () => {
    expect(() => encodeRound(-1)).toThrow("out of u32 range");
  });

  it("rejects round above u32 max", () => {
    expect(() => encodeRound(0x1_0000_0000)).toThrow("out of u32 range");
    expect(() => encodeRound(0x1_0000_0000n)).toThrow("out of u32 range");
  });

  it("rejects non-integer", () => {
    expect(() => encodeRound(1.2)).toThrow("finite integer");
  });
});

describe("encodeChoice", () => {
  it("encodes Heads and Tails as scvSymbol", () => {
    const heads = encodeChoice("Heads");
    const tails = encodeChoice("Tails");
    expect(heads.switch().name).toBe("scvSymbol");
    expect(tails.switch().name).toBe("scvSymbol");
    expect(heads.sym().toString()).toBe("Heads");
    expect(tails.sym().toString()).toBe("Tails");
  });

  it("rejects invalid choice", () => {
    expect(() => encodeChoice("Side" as never)).toThrow(
      "choice must be either",
    );
  });
});

describe("encodeAddress", () => {
  it("encodes Stellar public key as scvAddress", () => {
    const v = encodeAddress(SAMPLE_PUBLIC_KEY);
    expect(v.switch().name).toBe("scvAddress");
  });

  it("encodes Soroban contract id as scvAddress", () => {
    const v = encodeAddress(SAMPLE_CONTRACT_ID);
    expect(v.switch().name).toBe("scvAddress");
  });

  it("trims whitespace before encoding", () => {
    const v = encodeAddress(`  ${SAMPLE_PUBLIC_KEY}  `);
    expect(v.switch().name).toBe("scvAddress");
  });
});
