/**
 * Signing-policy firewall tests (#1502, extended for TRUSTLINE in #1487).
 *
 * These assert the firewall fails *closed*: every rejection path returns a
 * typed `SigningPolicyError` and never lets an envelope reach the wallet. The
 * TRUSTLINE cases matter most — a `changeTrust` spends base reserve, and #1487
 * makes the app build and sign one without leaving the user's flow, so the
 * allow-list for it has to be genuinely narrow.
 *
 * The `#1282` bug these guard against: all three call sites narrowed policy
 * rejections with `instanceof SigningPolicyError` after importing the class
 * `import type`, which erased it to `any` and turned the branch into dead
 * code. The last describe block covers that regression directly.
 */

import {
  Account,
  Asset,
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { stellarConfig } from "@/lib/stellarConfig";
import {
  evaluateSigningRequest,
  validateEnvelope,
  SigningPolicyError,
} from "@/shared-d/security/policy";
import { PROTECTED_OP_KEYS } from "@/shared-d/security/types";

const HOLDER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
const ISSUER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
const HOLDER_PK = HOLDER.publicKey();
const ISSUER_PK = ISSUER.publicKey();

const PASSPHRASE = stellarConfig.passphrase;
const SEQUENCE = "12345";

/**
 * `"timeout" in options` rather than a destructuring default: the SDK's
 * "never expires" constant is `undefined` in v14, and a destructuring default
 * would silently swap it back for a 30-second window — the exact opposite of
 * what the test is asking for.
 */
const NO_EXPIRY = 0;

interface BuildOptions {
  fee?: string;
  timeout?: number;
  passphrase?: string;
  operations?: Array<ReturnType<typeof Operation.changeTrust>>;
}

function buildXdr(options: BuildOptions = {}): string {
  const {
    fee = String(BASE_FEE),
    passphrase = PASSPHRASE,
    operations = [
      Operation.changeTrust({
        asset: new Asset("USDC", ISSUER_PK),
        limit: "1000.0000000",
      }),
    ],
  } = options;
  const timeout = "timeout" in options ? options.timeout : 30;

  let builder = new TransactionBuilder(new Account(HOLDER_PK, SEQUENCE), {
    fee,
    networkPassphrase: passphrase,
  }).setTimeout(timeout as number);

  for (const op of operations) builder = builder.addOperation(op);

  return builder.build().toXDR();
}

/** Wrap a valid envelope in a fee bump, which no flow in this app builds. */
function buildFeeBump(): FeeBumpTransaction {
  const inner = TransactionBuilder.fromXDR(buildXdr(), PASSPHRASE);
  if (inner instanceof FeeBumpTransaction) throw new Error("unreachable");
  return TransactionBuilder.buildFeeBumpTransaction(
    HOLDER,
    (Number(BASE_FEE) * 2).toString(),
    inner,
    PASSPHRASE,
  );
}

/** Assert a rejection, returning the error for further assertions. */
function expectRejection(
  envelopeXdr: string,
  opType: Parameters<typeof validateEnvelope>[1],
  reason: string,
): SigningPolicyError {
  const result = validateEnvelope(envelopeXdr, opType);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error).toBeInstanceOf(SigningPolicyError);
  expect(result.error.reason).toBe(reason);
  expect(result.error.operation).toBe(opType);
  return result.error;
}

describe("validateEnvelope — TRUSTLINE", () => {
  it("accepts a single well-formed changeTrust and exposes asset, issuer and limit", () => {
    const result = validateEnvelope(buildXdr(), "TRUSTLINE");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.decoded.type).toBe("TRUSTLINE");
    expect(result.decoded.source).toBe(HOLDER_PK);
    expect(result.decoded.operations).toHaveLength(1);
    expect(result.decoded.operations.at(0)).toEqual({
      type: "changeTrust",
      assetCode: "USDC",
      assetIssuer: ISSUER_PK,
      limit: "1000.0000000",
    });
  });

  it("accepts a 12-character asset code, which uses a different XDR union arm", () => {
    const code = "ABCDEFGHIJKL";
    const result = validateEnvelope(
      buildXdr({
        operations: [
          Operation.changeTrust({ asset: new Asset(code, ISSUER_PK), limit: "5" }),
        ],
      }),
      "TRUSTLINE",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.decoded.operations.at(0)?.assetCode).toBe(code);
  });

  it("rejects a changeTrust batched with a second operation", () => {
    const result = validateEnvelope(
      buildXdr({
        operations: [
          Operation.changeTrust({ asset: new Asset("USDC", ISSUER_PK), limit: "1000" }),
          Operation.payment({
            destination: ISSUER_PK,
            asset: Asset.native(),
            amount: "1",
          }),
        ],
      }),
      "TRUSTLINE",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.reason).toBe("unexpected_operation");
  });

  it("rejects a payment, even though payment is a real operation", () => {
    expectRejection(
      buildXdr({
        operations: [
          Operation.payment({
            destination: ISSUER_PK,
            asset: Asset.native(),
            amount: "1",
          }),
        ],
      }),
      "TRUSTLINE",
      "unexpected_operation",
    );
  });

  it("rejects a changeTrust on the native asset, which has no issuer to key on", () => {
    // The SDK will happily *build* this, so the firewall is the only thing
    // between it and a signature.
    expectRejection(
      buildXdr({
        operations: [Operation.changeTrust({ asset: Asset.native(), limit: "1000" })],
      }),
      "TRUSTLINE",
      "extra_fields",
    );
  });

  it("rejects a fee-bump envelope rather than unwrapping the inner transaction", () => {
    const bump = buildFeeBump();
    expect(bump).toBeInstanceOf(FeeBumpTransaction);

    expectRejection(bump.toXDR(), "TRUSTLINE", "malformed_xdr");
  });
});

describe("validateEnvelope — shared invariants", () => {
  it("rejects XDR that is not a transaction at all", () => {
    expectRejection("unsigned-xdr", "TRUSTLINE", "malformed_xdr");
    expectRejection("", "TRUSTLINE", "malformed_xdr");
  });

  it("rejects an envelope built for a different network", () => {
    const other = PASSPHRASE === Networks.TESTNET ? Networks.PUBLIC : Networks.TESTNET;

    // An *unsigned* envelope does not record its network in its contents, and
    // `fromXDR` overwrites the decoded passphrase with whatever it was handed
    // — so comparing the decoded value against the config would compare the
    // caller's argument against itself and never fire. The mistake that would
    // actually cause a cross-network signature is a call site handing the
    // policy a foreign passphrase, and that is what gets rejected.
    const envelope = buildXdr({ passphrase: other });
    const result = validateEnvelope(envelope, "TRUSTLINE", { passphrase: other });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.reason).toBe("network_mismatch");
    expect(result.error.message).toMatch(/other than the configured one/);
  });

  it("rejects a transaction with no expiry", () => {
    // Both `setTimeout(0)` and the SDK's "infinite" timeout encode as
    // `maxTime: 0`, which is Stellar's on-the-wire representation of "never
    // expires". (`xdr.TimeoutInfinite` is `undefined` in v14, which the builder
    // would read as "unspecified" and default to 30s.)
    expectRejection(buildXdr({ timeout: NO_EXPIRY }), "TRUSTLINE", "timebound_anomaly");
  });

  it("rejects a transaction whose expiry has already passed", () => {
    // The public builder refuses a negative timeout, so a bounded-but-expired
    // envelope can only be produced by moving the clock forward after building
    // it. That is also the realistic case: a tab left open past its window.
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const envelope = buildXdr({ timeout: 30 });
    jest.setSystemTime(new Date("2026-01-01T01:00:00Z"));

    try {
      expectRejection(envelope, "TRUSTLINE", "timebound_anomaly");
    } finally {
      jest.useRealTimers();
    }
  });

  it("rejects a fee below the protocol minimum", () => {
    expectRejection(buildXdr({ fee: "50" }), "TRUSTLINE", "fee_anomaly");
  });

  it("rejects a fee-bump envelope for a non-TRUSTLINE op too", () => {
    expectRejection(buildFeeBump().toXDR(), "STAKE", "malformed_xdr");
  });
});

describe("validateEnvelope — the allow-list is per-op", () => {
  it("rejects a changeTrust under every Soroban op, so a trustline can never pose as a business transaction", () => {
    const envelope = buildXdr();
    for (const opType of PROTECTED_OP_KEYS.filter((op) => op !== "TRUSTLINE")) {
      expectRejection(envelope, opType, "unexpected_operation");
    }
  });
});

describe("evaluateSigningRequest", () => {
  it("returns the decoded envelope on success", () => {
    const decoded = evaluateSigningRequest(buildXdr(), "TRUSTLINE");

    expect(decoded.type).toBe("TRUSTLINE");
    expect(decoded.operations.at(0)?.assetIssuer).toBe(ISSUER_PK);
  });

  it("throws a SigningPolicyError that `instanceof` narrowing can actually catch", () => {
    // Regression guard for the `import type` bug: with a type-only import this
    // call site's `instanceof` branch compiled to dead code, so a policy
    // rejection surfaced to the user as an unexpected crash.
    let caught: unknown;
    try {
      evaluateSigningRequest("not-xdr", "TRUSTLINE");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SigningPolicyError);
    expect((caught as SigningPolicyError).reason).toBe("malformed_xdr");
    expect((caught as SigningPolicyError).operation).toBe("TRUSTLINE");
  });
});
