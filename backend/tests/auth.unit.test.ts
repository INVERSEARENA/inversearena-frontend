import { test, mock, afterEach } from "node:test";
import assert from "node:assert";
import jwt from "jsonwebtoken";
import { Keypair } from "@stellar/stellar-sdk";
import { AuthService } from "../src/services/authService";
import { NonceModel } from "../src/db/models/nonce.model";
import { UserModel } from "../src/db/models/user.model";

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

test("AuthService.refreshTokens: valid token", async () => {
  const secret = process.env.JWT_SECRET!;
  const payload = { sub: "user-id", wallet: VALID_ADDRESS, type: "refresh" };
  const refreshToken = jwt.sign(payload, secret);

  const result = await authService.refreshTokens(refreshToken);

  assert.ok(result.accessToken);
  assert.ok(result.refreshToken);
  
  const decodedAccess = jwt.verify(result.accessToken, secret) as any;
  assert.strictEqual(decodedAccess.sub, "user-id");
  assert.strictEqual(decodedAccess.type, "access");
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

test("AuthService.verifyAccessToken: valid token", () => {
  const secret = process.env.JWT_SECRET!;
  const payload = { sub: "user-id", wallet: VALID_ADDRESS, type: "access" };
  const token = jwt.sign(payload, secret);

  const result = authService.verifyAccessToken(token);

  assert.strictEqual(result.sub, "user-id");
  assert.strictEqual(result.type, "access");
});
