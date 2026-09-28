/**
 * `changeTrust` builder tests (#1487).
 *
 * The load-bearing assertion is the last one: a builder that produces an
 * envelope the signing policy rejects is worse than no builder at all, because
 * the user is taken through a guided flow and then stopped at the wallet
 * prompt. Builder and policy are therefore tested against each other, not only
 * in isolation.
 */

import { Account, Keypair, Transaction } from "@stellar/stellar-sdk";
import { evaluateSigningRequest, SigningPolicyError } from "@/shared-d/security/policy";
import { buildChangeTrustTransaction } from "@/shared-d/utils/stellar-transactions";
import { ContractError } from "@/shared-d/utils/contract-error";

const HOLDER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
const ISSUER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));

// A real `Account`, not a stub: `TransactionBuilder.build()` calls
// `source.accountId()`, so a hand-rolled mock would fail inside the SDK.
jest.mock("@/shared-d/services/stellarRpcGateway", () => ({
  StellarRpcGateway: jest.fn().mockImplementation(() => ({
    getAccount: jest
      .fn()
      .mockResolvedValue(
        new Account("GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57", "12345"),
      ),
  })),
  getHorizonUrl: jest.fn().mockReturnValue("https://horizon.test"),
}));

const USDC = { code: "USDC", issuer: ISSUER.publicKey() };

async function build(limit = "1000.0000000", asset = USDC) {
  const tx = await buildChangeTrustTransaction(
    HOLDER.publicKey(),
    asset,
    limit,
  );
  return tx as Transaction;
}

describe("buildChangeTrustTransaction", () => {
  it("builds a single changeTrust with the requested limit", async () => {
    const tx = await build("1000.0000000");

    expect(tx).toBeInstanceOf(Transaction);
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0].type).toBe("changeTrust");
    expect(tx.operations[0].limit).toBe("1000.0000000");
  });

  it("charges the classic per-operation fee, not a Soroban resource fee", async () => {
    const tx = await build();

    // A `changeTrust` has no footprint, so `prepareTransaction` would compute a
    // resource fee that is meaningless here.
    expect(Number(tx.fee)).toBe(100);
  });

  it("produces an envelope the signing policy accepts", async () => {
    const tx = await build("250.0000000");
    const decoded = evaluateSigningRequest(tx.toXDR(), "TRUSTLINE");

    expect(decoded.type).toBe("TRUSTLINE");
    expect(decoded.operations[0]).toEqual({
      type: "changeTrust",
      assetCode: "USDC",
      assetIssuer: ISSUER.publicKey(),
      limit: "250.0000000",
    });
  });

  it("sets a short expiry, so a signed trustline cannot be replayed indefinitely", async () => {
    const tx = await build();
    const { maxTime } = tx.timeBounds;
    const window = Number(maxTime) - Math.floor(Date.now() / 1000);

    expect(window).toBeGreaterThan(0);
    expect(window).toBeLessThanOrEqual(300);
  });

  it("rejects a limit with more than 7 decimal places", async () => {
    // Stellar has exactly 7 decimals of asset precision; the SDK would round
    // this, so the user would sign a different limit than the UI displayed.
    await expect(build("1000.00000001")).rejects.toThrow();
  });

  it("rejects a negative limit", async () => {
    await expect(build("-1")).rejects.toThrow();
  });

  it("rejects a malformed asset code", async () => {
    await expect(build("1000", { code: "US-D", issuer: ISSUER.publicKey() })).rejects.toThrow();
    await expect(build("1000", { code: "1USDC", issuer: ISSUER.publicKey() })).rejects.toThrow();
  });

  it("rejects a malformed issuer", async () => {
    await expect(build("1000", { code: "USDC", issuer: "not-a-key" })).rejects.toThrow();
  });

  it("refuses a self-issued trustline, which the network would reject anyway", async () => {
    // The user would otherwise be walked through a guided flow, asked to sign,
    // and have the transaction fail with CHANGE_TRUST_SELF_NOT_ALLOWED.
    await expect(
      build("1000", { code: "USDC", issuer: HOLDER.publicKey() }),
    ).rejects.toThrow(/issued by the connected account/i);
  });

  it("surfaces builder failures as ContractError so the UI can branch on the code", async () => {
    await expect(build("not-a-number")).rejects.toBeInstanceOf(ContractError);
  });

  it("never asks the wallet to sign an envelope the policy would reject", async () => {
    const tx = await build();
    let policyError: SigningPolicyError | null = null;

    try {
      evaluateSigningRequest(tx.toXDR(), "TRUSTLINE");
    } catch (error) {
      if (error instanceof SigningPolicyError) policyError = error;
    }

    expect(policyError).toBeNull();
  });
});
