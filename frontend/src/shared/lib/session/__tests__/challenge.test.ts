import { createHash } from "node:crypto";

import {
  buildChallengeTransactionXdr,
  CHALLENGE_DATA_KEY,
  normalizeSignature,
  signChallenge,
} from "../challenge";

jest.mock("@stellar/stellar-sdk", () => {
  const operations: Array<{ name: string; value: Uint8Array }> = [];
  class Account {
    constructor(public address: string, public sequence: string) {}
  }
  const Operation = {
    manageData: jest.fn((args: { name: string; value: Uint8Array }) => {
      operations.push(args);
      return { type: "manageData", ...args };
    }),
  };
  class TransactionBuilder {
    private operation: unknown;
    constructor(public account: Account, public options: unknown) {}
    addOperation(operation: unknown) {
      this.operation = operation;
      return this;
    }
    build() {
      return { toXDR: () => `xdr-for:${(this.operation as { name: string }).name}`, operation: this.operation };
    }
  }
  return { Account, Operation, TransactionBuilder, __operations: operations };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sdk = require("@stellar/stellar-sdk") as { __operations: Array<{ name: string; value: Uint8Array }> };

const WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

describe("challenge signing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sdk.__operations.length = 0;
  });

  it("normalises message signatures from common wallet response shapes", () => {
    expect(normalizeSignature("c2lnbmF0dXJl")).toBe("c2lnbmF0dXJl");
    expect(normalizeSignature({ signature: "c2lnbmF0dXJl" })).toBe("c2lnbmF0dXJl");
    expect(normalizeSignature({ signedMessage: "c2lnbmF0dXJl" })).toBe("c2lnbmF0dXJl");
    expect(normalizeSignature("0x616263")).toBe(Buffer.from("abc").toString("base64"));
    expect(() => normalizeSignature({})).toThrow(/did not return a signature/i);
  });

  it("embeds the SHA-256 digest of the backend nonce in a challenge transaction", async () => {
    const xdr = await buildChallengeTransactionXdr("backend-nonce", WALLET, "passphrase");

    expect(xdr).toContain(CHALLENGE_DATA_KEY);
    expect(sdk.__operations).toHaveLength(1);
    expect(Buffer.from(sdk.__operations[0]!.value).toString("base64")).toBe(
      createHash("sha256").update("backend-nonce").digest("base64"),
    );
  });

  it("prefers message signing when the wallet supports it", async () => {
    const signMessage = jest.fn(async () => ({ signedMessage: "c2lnbmF0dXJl" }));
    const signTransaction = jest.fn(async () => "signed-xdr");

    const proof = await signChallenge(
      "nonce",
      { walletAddress: WALLET, signMessage, signTransaction },
      "passphrase",
    );

    expect(proof).toEqual({ signature: "c2lnbmF0dXJl" });
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("passes the signed challenge XDR through verbatim", async () => {
    // A hex-looking XDR string must not be decoded as a hex signature.
    const signTransaction = jest.fn(async () => "abcdef");

    const proof = await signChallenge(
      "nonce",
      { walletAddress: WALLET, signTransaction },
      "passphrase",
    );

    expect(proof).toEqual({ signedChallengeXdr: "abcdef" });
  });

  it("falls back to a signed challenge transaction when message signing fails", async () => {
    const signMessage = jest.fn(async () => {
      throw new Error("not supported");
    });
    const signTransaction = jest.fn(async () => "signed-xdr");

    const proof = await signChallenge(
      "nonce",
      { walletAddress: WALLET, signMessage, signTransaction },
      "passphrase",
    );

    expect(proof).toEqual({ signedChallengeXdr: "signed-xdr" });
    expect(signTransaction).toHaveBeenCalledWith(expect.stringContaining(CHALLENGE_DATA_KEY));
  });
});
