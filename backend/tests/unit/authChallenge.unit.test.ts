import { createHash } from "node:crypto";
import { Account, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

import { AuthService } from "../../src/services/authService";
import { NonceModel } from "../../src/db/models/nonce.model";
import { UserModel } from "../../src/db/models/user.model";
import { RefreshTokenModel } from "../../src/db/models/refreshToken.model";

jest.mock("../../src/db/models/nonce.model", () => ({
  NonceModel: { findOne: jest.fn(), findByIdAndUpdate: jest.fn() },
}));
jest.mock("../../src/db/models/user.model", () => ({
  UserModel: { findOneAndUpdate: jest.fn() },
}));
jest.mock("../../src/db/models/refreshToken.model", () => ({
  RefreshTokenModel: { create: jest.fn(), findOneAndUpdate: jest.fn(), findOne: jest.fn(), updateMany: jest.fn() },
  generateFamilyId: jest.fn(() => "family"),
}));

const CHALLENGE_DATA_KEY = "inversearena_auth_challenge";
const PASSPHRASE = "Test SDF Network ; September 2015";

function buildSignedChallenge(nonce: string, keypair: Keypair, digestOverride?: Buffer): string {
  const digest = digestOverride ?? createHash("sha256").update(nonce).digest();
  const transaction = new TransactionBuilder(new Account(keypair.publicKey(), "0"), {
    fee: "100",
    networkPassphrase: PASSPHRASE,
    timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 300 },
  })
    .addOperation(Operation.manageData({ name: CHALLENGE_DATA_KEY, value: digest }))
    .build();
  transaction.sign(keypair);
  return transaction.toXDR();
}

describe("AuthService challenge-transaction login (#1714)", () => {
  const keypair = Keypair.random();
  const nonce = "Sign this message to authenticate with InverseArena:\nnonce=abc";

  beforeEach(() => {
    jest.clearAllMocks();
    (NonceModel.findOne as jest.Mock).mockReturnValue({
      sort: () => ({ _id: "nonce-id", nonce, walletAddress: keypair.publicKey(), used: false }),
    });
    (NonceModel.findByIdAndUpdate as jest.Mock).mockResolvedValue({});
    (UserModel.findOneAndUpdate as jest.Mock).mockResolvedValue({
      _id: "user-id",
      walletAddress: keypair.publicKey(),
      joinedAt: new Date(),
      lastLoginAt: new Date(),
    });
    (RefreshTokenModel.create as jest.Mock).mockResolvedValue({});
  });

  const service = () =>
    new AuthService({
      addSessions: jest.fn(async () => undefined),
      isActive: jest.fn(async () => true),
      removeSession: jest.fn(async () => undefined),
      removeAllSessions: jest.fn(async () => 0),
    } as never);

  it("issues a session for a correctly signed challenge transaction", async () => {
    const result = await service().verifyChallengeAndLogin(
      keypair.publicKey(),
      buildSignedChallenge(nonce, keypair),
    );

    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).toEqual(expect.any(String));
    expect(NonceModel.findByIdAndUpdate).toHaveBeenCalledWith("nonce-id", { used: true });
  });

  it("rejects a transaction carrying a different nonce digest", async () => {
    const signed = buildSignedChallenge(nonce, keypair, createHash("sha256").update("other").digest());

    await expect(
      service().verifyChallengeAndLogin(keypair.publicKey(), signed),
    ).rejects.toMatchObject({ status: 401 });
    expect(NonceModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects a signature from another wallet", async () => {
    const signed = buildSignedChallenge(nonce, keypair);
    const other = Keypair.random().publicKey();

    await expect(service().verifyChallengeAndLogin(other, signed)).rejects.toMatchObject({ status: 401 });
  });
});
