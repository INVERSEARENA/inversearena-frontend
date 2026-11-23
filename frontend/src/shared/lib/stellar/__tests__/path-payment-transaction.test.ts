/**
 * Funded-join builder / signing-policy cross-checks (#1716).
 *
 * A builder that produces an envelope the signing firewall rejects is worse
 * than no builder at all: the player is walked through a quote and a wallet
 * prompt only to be stopped at the last step. These tests therefore assert the
 * real builders and the real firewall against each other, including the
 * rejected envelopes that must never reach a wallet.
 */

import { Account, Contract, Keypair } from "@stellar/stellar-sdk";
import { stellarConfig } from "@/shared/config/stellarConfig";
import {
  evaluateSigningRequest,
  SigningPolicyError,
} from "@/shared/lib/security/policy";
import {
  buildClaimCallOperation,
  buildJoinCallOperation,
  buildPathPaymentStrictReceiveOperation,
  composeUnsignedTransactionWithOperations,
} from "@/shared/lib/stellar/soroban-transaction-composer";
import type { PathQuote } from "@/shared/lib/stellar/path-payment-quote";
import {
  buildJoinWithPathPaymentTransaction,
  buildPathPaymentTransaction,
  NETWORK_PASSPHRASE,
} from "@/shared/lib/stellar/stellar-transactions";

const PUBLIC_KEY = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const POOL_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const ISSUER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();
const OTHER_KEY = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 11)).publicKey();

const QUOTE: PathQuote = {
  sourceAsset: { kind: "native", code: "XLM" },
  destinationAsset: { kind: "credit", code: "USDC", issuer: ISSUER },
  sourceAmount: "12.3000000",
  destinationAmount: "10.0000000",
  sendMax: "12.4230000",
  path: [],
  slippageBps: 100,
  createdAt: Date.now(),
  expiresAt: Date.now() + 30_000,
};

function mockHorizonAccountFetch() {
  return jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ sequence: "1" }),
  });
}

describe("funded-join transaction builders", () => {
  beforeEach(() => {
    (global.fetch as unknown) = mockHorizonAccountFetch();
  });

  it("bundles path payment then join_arena and passes the JOIN_PATH firewall", async () => {
    const tx = await buildJoinWithPathPaymentTransaction(PUBLIC_KEY, POOL_ID, QUOTE);

    expect(tx.operations.map((operation) => operation.type)).toEqual([
      "pathPaymentStrictReceive",
      "invokeHostFunction",
    ]);

    const decoded = evaluateSigningRequest(tx.toXDR(), "JOIN_PATH");
    expect(decoded.operations).toHaveLength(2);
    expect(decoded.operations[0]?.pathPayment).toMatchObject({
      sendAssetCode: "XLM",
      sendAssetIssuer: null,
      sendMax: QUOTE.sendMax,
      destination: PUBLIC_KEY,
      destAssetCode: "USDC",
      destAssetIssuer: ISSUER,
      destAmount: QUOTE.destinationAmount,
      path: [],
    });
    expect(decoded.operations[1]?.invocation).toEqual({
      functionName: "join_arena",
      contractId: POOL_ID,
    });
  });

  it("builds a standalone path payment that passes PATH_PAYMENT but not JOIN_PATH", async () => {
    const tx = await buildPathPaymentTransaction(PUBLIC_KEY, QUOTE);

    expect(tx.operations.map((operation) => operation.type)).toEqual([
      "pathPaymentStrictReceive",
    ]);
    expect(
      evaluateSigningRequest(tx.toXDR(), "PATH_PAYMENT").operations[0]?.pathPayment
        ?.destination,
    ).toBe(PUBLIC_KEY);
    expect(() => evaluateSigningRequest(tx.toXDR(), "JOIN_PATH")).toThrow(
      SigningPolicyError,
    );
  });

  it("bundled transactions with join_arena before the path payment are rejected", () => {
    const account = new Account(PUBLIC_KEY, "1");
    const tx = composeUnsignedTransactionWithOperations(account, {
      fee: "10000",
      networkPassphrase: NETWORK_PASSPHRASE,
      timeout: 30,
      operations: [
        buildJoinCallOperation(new Contract(POOL_ID), PUBLIC_KEY),
        buildPathPaymentStrictReceiveOperation(PUBLIC_KEY, QUOTE),
      ],
    });

    expect(() => evaluateSigningRequest(tx.toXDR(), "JOIN_PATH")).toThrow(
      /different order/,
    );
  });

  it("bundled transactions invoking a function other than join_arena are rejected", () => {
    const account = new Account(PUBLIC_KEY, "1");
    const tx = composeUnsignedTransactionWithOperations(account, {
      fee: "10000",
      networkPassphrase: stellarConfig.passphrase,
      timeout: 30,
      operations: [
        buildPathPaymentStrictReceiveOperation(PUBLIC_KEY, QUOTE),
        buildClaimCallOperation(new Contract(POOL_ID), PUBLIC_KEY),
      ],
    });

    expect(() => evaluateSigningRequest(tx.toXDR(), "JOIN_PATH")).toThrow(
      /must be join_arena/,
    );
  });

  it("bundled path payments that credit a different account are rejected", () => {
    const account = new Account(PUBLIC_KEY, "1");
    const tx = composeUnsignedTransactionWithOperations(account, {
      fee: "10000",
      networkPassphrase: stellarConfig.passphrase,
      timeout: 30,
      operations: [
        buildPathPaymentStrictReceiveOperation(OTHER_KEY, QUOTE),
        buildJoinCallOperation(new Contract(POOL_ID), PUBLIC_KEY),
      ],
    });

    expect(() => evaluateSigningRequest(tx.toXDR(), "JOIN_PATH")).toThrow(
      /must credit the signing account/,
    );
  });
});
