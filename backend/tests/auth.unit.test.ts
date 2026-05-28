import { test, mock, afterEach } from "node:test";
import assert from "node:assert";
import jwt from "jsonwebtoken";
import { Keypair } from "@stellar/stellar-sdk";
import { AuthService } from "../src/services/authService";
import { NonceModel } from "../src/db/models/nonce.model";
import { UserModel } from "../src/db/models/user.model";
import { RefreshTokenModel } from "../src/db/models/refreshToken.model";

// Mock environment variables
process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.NONCE_TTL_SECONDS = "300";

const authService = new AuthService();
const VALID_ADDRESS = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

afterEach(() => {
  mock.reset();
});

test("AuthService.requestNonce: successful request", async () => {
  const walletAddress = VALID_ADDRESS;

  // Mock NonceModel.create
  const mockCreate = mock.method(NonceModel, "create", async () => ({}));

  const result = await authService.requestNonce(walletAddress);

  assert.strictEqual(typeof result.nonce, "string");
  assert.ok(result.nonce.startsWith("Sign this message to authenticate"));
  assert.ok(result.expiresAt instanceof Date);
  assert.strictEqual(mockCreate.mock.callCount(), 1);

  const callParams = mockCreate.mock.calls[0].arguments[0] as { walletAddress: string };
  assert.strictEqual(callParams.walletAddress, walletAddress);
});

test("AuthService.verifySignatureAndLogin: successful login", async () => {
  const walletAddress = VALID_ADDRESS;
  const nonce = "Sign this message to authenticate with InverseArena:\nabcdef";
  const signature = "c2lnbmF0dXJl"; // dummy base64

  // Mock NonceModel.findOne
  mock.method(NonceModel, "findOne", () => ({
    sort: () => ({
      _id: "nonce-id",
      nonce,
      walletAddress,
      used: false
    })
  }));

  // Mock Keypair.verify
  const mockVerify = mock.fn(() => true);
  mock.method(Keypair, "fromPublicKey", () => ({
    verify: mockVerify
  }));

  // Mock NonceModel.findByIdAndUpdate
  mock.method(NonceModel, "findByIdAndUpdate", async () => ({}));

  // Mock UserModel.findOneAndUpdate
  mock.method(UserModel, "findOneAndUpdate", async () => ({
    _id: "user-id",
    walletAddress,
    joinedAt: new Date(),
    lastLoginAt: new Date()
  }));

  // Mock RefreshTokenModel.create
  mock.method(RefreshTokenModel, "create", async () => ({}));

  const result = await authService.verifySignatureAndLogin(walletAddress, signature);

  assert.ok(result.accessToken);
  assert.strictEqual(result.user.walletAddress, walletAddress);
});

test("AuthService.verifySignatureAndLogin: missing nonce throws 401", async () => {
  const walletAddress = VALID_ADDRESS;

  mock.method(NonceModel, "findOne", () => ({
    sort: () => null
  }));

  await assert.rejects(
    () => authService.verifySignatureAndLogin(walletAddress, "sig"),
    (err: any) => err.status === 401 && err.message.includes("No valid nonce found")
  );
});

test("AuthService.requestNonce: invalid address throws 400", async () => {
  await assert.rejects(
    () => authService.requestNonce("invalid-address"),
    (err: any) => err.status === 400 && err.message.includes("Invalid Stellar wallet address")
  );
});

test("AuthService.refreshTokens: valid token with rotation", async () => {
  const secret = process.env.JWT_SECRET!;
  const userId = "user-id";
  const payload = { sub: userId, wallet: VALID_ADDRESS, type: "refresh" };
  const refreshToken = jwt.sign(payload, secret);

  // Mock RefreshTokenModel.findOne to return a non-used, non-revoked token
  mock.method(RefreshTokenModel, "findOne", async () => ({
    _id: "stored-id",
    tokenHash: "somehash",
    familyId: "family-1",
    userId,
    used: false,
    revoked: false,
  }));

  // Mock RefreshTokenModel.findByIdAndUpdate
  mock.method(RefreshTokenModel, "findByIdAndUpdate", async () => ({}));

  // Mock RefreshTokenModel.create for the new token
  mock.method(RefreshTokenModel, "create", async () => ({}));

  const result = await authService.refreshTokens(refreshToken);

  assert.ok(result.accessToken);
  assert.ok(result.refreshToken);

  const decodedAccess = jwt.verify(result.accessToken, secret) as any;
  assert.strictEqual(decodedAccess.sub, userId);
  assert.strictEqual(decodedAccess.type, "access");
});

test("AuthService.refreshTokens: reuse of consumed token invalidates family", async () => {
  const secret = process.env.JWT_SECRET!;
  const userId = "user-id";
  const payload = { sub: userId, wallet: VALID_ADDRESS, type: "refresh" };
  const refreshToken = jwt.sign(payload, secret);

  const familyId = "family-attack";

  // First call: token is not yet used — refresh succeeds
  mock.method(RefreshTokenModel, "findOne", async () => ({
    _id: "stored-id-1",
    tokenHash: "somehash",
    familyId,
    userId,
    used: false,
    revoked: false,
  }));
  mock.method(RefreshTokenModel, "findByIdAndUpdate", async () => ({}));
  mock.method(RefreshTokenModel, "create", async () => ({}));

  const result = await authService.refreshTokens(refreshToken);
  assert.ok(result.accessToken);

  // Reset mocks
  mock.reset();

  // Second call with the SAME token (simulating reuse attack)
  // The stored token is now marked as used
  mock.method(RefreshTokenModel, "findOne", async () => ({
    _id: "stored-id-1",
    tokenHash: "somehash",
    familyId,
    userId,
    used: true,
    revoked: false,
  }));

  // Mock updateMany to track calls
  let revokedFamilyId = "";
  mock.method(RefreshTokenModel, "updateMany", async (filter: any) => {
    revokedFamilyId = filter.familyId;
    return { modifiedCount: 1 };
  });

  await assert.rejects(
    () => authService.refreshTokens(refreshToken),
    (err: any) =>
      err.status === 401 &&
      err.message.includes("Refresh token reuse detected")
  );

  // Verify the entire family was revoked
  assert.strictEqual(revokedFamilyId, familyId);
});

test("AuthService.refreshTokens: revoked token returns 401", async () => {
  const secret = process.env.JWT_SECRET!;
  const payload = { sub: "user-id", wallet: VALID_ADDRESS, type: "refresh" };
  const refreshToken = jwt.sign(payload, secret);

  mock.method(RefreshTokenModel, "findOne", async () => ({
    _id: "stored-id-revoked",
    tokenHash: "somehash",
    familyId: "family-revoked",
    userId: "user-id",
    used: false,
    revoked: true,
  }));

  await assert.rejects(
    () => authService.refreshTokens(refreshToken),
    (err: any) => err.status === 401 && err.message.includes("has been revoked")
  );
});

test("AuthService.refreshTokens: unknown token returns 401", async () => {
  const secret = process.env.JWT_SECRET!;
  const payload = { sub: "user-id", wallet: VALID_ADDRESS, type: "refresh" };
  const refreshToken = jwt.sign(payload, secret);

  mock.method(RefreshTokenModel, "findOne", async () => null);

  await assert.rejects(
    () => authService.refreshTokens(refreshToken),
    (err: any) =>
      err.status === 401 &&
      err.message.includes("has been revoked or expired")
  );
});

test("AuthService.refreshTokens: invalid token types", async () => {
  const secret = process.env.JWT_SECRET!;

  const accessPayload = { sub: "user-id", wallet: VALID_ADDRESS, type: "access" };
  const accessToken = jwt.sign(accessPayload, secret);

  await assert.rejects(
    () => authService.refreshTokens(accessToken),
    (err: any) => err.status === 401 && err.message.includes("not a refresh token")
  );

  await assert.rejects(
    () => authService.refreshTokens("not-a-token"),
    (err: any) => err.status === 401
  );
});

test("AuthService.logout: revokes all user tokens", async () => {
  const userId = "user-id";

  let revokedFilter: any = null;
  mock.method(RefreshTokenModel, "updateMany", async (filter: any, update: any) => {
    revokedFilter = filter;
    return { modifiedCount: 3 };
  });

  await authService.logout(userId);

  assert.ok(revokedFilter);
  assert.strictEqual(revokedFilter.userId, userId);
  assert.strictEqual(revokedFilter.revoked, false);
});

test("AuthService.verifyAccessToken: valid token", () => {
  const secret = process.env.JWT_SECRET!;
  const payload = { sub: "user-id", wallet: VALID_ADDRESS, type: "access" };
  const token = jwt.sign(payload, secret);

  const result = authService.verifyAccessToken(token);

  assert.strictEqual(result.sub, "user-id");
  assert.strictEqual(result.type, "access");
});
