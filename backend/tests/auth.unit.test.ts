import { test, mock, afterEach, beforeEach } from "node:test";
import assert from "node:assert";
import jwt from "jsonwebtoken";
import { Keypair } from "@stellar/stellar-sdk";
import { AuthService } from "../src/services/authService";
import { NonceModel } from "../src/db/models/nonce.model";
import { UserModel } from "../src/db/models/user.model";
import { RefreshTokenModel } from "../src/db/models/refreshToken.model";
import { SessionStore } from "../src/cache/sessionStore";

// Mock environment variables
process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.NONCE_TTL_SECONDS = "300";

/**
 * In-memory replacement for the Redis-backed SessionStore so the auth unit
 * tests can run without a live Redis. Behaves the same shape (add/isActive/
 * removeSession/removeAllSessions) as the production store.
 */
class FakeSessionStore extends SessionStore {
  private readonly jtis = new Map<string, string>();
  private readonly walletToJtis = new Map<string, Set<string>>();

  constructor() {
    super({} as never);
  }

  async addSession(wallet: string, jti: string, _ttl: number): Promise<void> {
    this.jtis.set(jti, wallet);
    if (!this.walletToJtis.has(wallet)) this.walletToJtis.set(wallet, new Set());
    this.walletToJtis.get(wallet)!.add(jti);
  }

  async isActive(jti: string): Promise<boolean> {
    return this.jtis.has(jti);
  }

  async removeSession(jti: string): Promise<void> {
    const wallet = this.jtis.get(jti);
    this.jtis.delete(jti);
    if (wallet) this.walletToJtis.get(wallet)?.delete(jti);
  }

  async removeAllSessions(wallet: string): Promise<number> {
    const set = this.walletToJtis.get(wallet);
    if (!set) return 0;
    for (const jti of set) this.jtis.delete(jti);
    const n = set.size;
    this.walletToJtis.delete(wallet);
    return n;
  }
}

let sessions: FakeSessionStore;
let authService: AuthService;
const VALID_ADDRESS = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

beforeEach(() => {
  sessions = new FakeSessionStore();
  authService = new AuthService(sessions);
});

afterEach(() => {
  mock.reset();
});

test("AuthService.requestNonce: successful request", async () => {
  const walletAddress = VALID_ADDRESS;

  // Mock NonceModel.create
  const mockCreate = mock.method(NonceModel, "create", async () => ({}));
  const mockUpdateMany = mock.method(NonceModel, "updateMany", async () => ({}));

  const result = await authService.requestNonce(walletAddress);

  assert.strictEqual(typeof result.nonce, "string");
  assert.ok(result.nonce.startsWith("Sign this message to authenticate"));
  assert.ok(result.expiresAt instanceof Date);
  assert.strictEqual(mockUpdateMany.mock.callCount(), 1);
  assert.strictEqual(mockCreate.mock.callCount(), 1);

  const updateParams = mockUpdateMany.mock.calls[0].arguments[0] as Record<string, unknown>;
  assert.strictEqual(updateParams.walletAddress, walletAddress);
  assert.strictEqual(updateParams.used, false);

  const createParams = mockCreate.mock.calls[0].arguments[0] as { walletAddress: string };
  assert.strictEqual(createParams.walletAddress, walletAddress);
});

test("AuthService.requestNonce: invalidates prior nonces before creating a new one", async () => {
  const walletAddress = VALID_ADDRESS;
  const mockUpdateMany = mock.method(NonceModel, "updateMany", async () => ({}));
  const mockCreate = mock.method(NonceModel, "create", async () => ({}));

  await authService.requestNonce(walletAddress);

  assert.strictEqual(mockUpdateMany.mock.callCount(), 1);
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
  const jti = "refresh-jti-1";
  const payload = { sub: userId, wallet: VALID_ADDRESS, type: "refresh", jti };
  const refreshToken = jwt.sign(payload, secret);
  // Pre-register the JTI as active so the refresh endpoint accepts it.
  await sessions.addSession(VALID_ADDRESS, jti, 3600);

  mock.method(RefreshTokenModel, "findOne", async () => ({
    _id: "stored-id",
    tokenHash: "somehash",
    familyId: "family-1",
    userId,
    used: false,
    revoked: false,
  }));
  mock.method(RefreshTokenModel, "findByIdAndUpdate", async () => ({}));
  mock.method(RefreshTokenModel, "create", async () => ({}));

  const result = await authService.refreshTokens(refreshToken);

  assert.ok(result.accessToken);
  assert.ok(result.refreshToken);

  const decodedAccess = jwt.verify(result.accessToken, secret) as any;
  assert.strictEqual(decodedAccess.sub, userId);
  assert.strictEqual(decodedAccess.type, "access");
  assert.ok(decodedAccess.jti, "rotated access token must include a jti");

  // Old refresh JTI must be retired after rotation.
  assert.strictEqual(await sessions.isActive(jti), false);
});

test("AuthService.refreshTokens: reuse of consumed token invalidates family", async () => {
  const secret = process.env.JWT_SECRET!;
  const userId = "user-id";
  const jti = "refresh-jti-attack";
  const payload = { sub: userId, wallet: VALID_ADDRESS, type: "refresh", jti };
  const refreshToken = jwt.sign(payload, secret);
  // The attacker holds a still-active JTI; reuse detection must fire AFTER
  // the DB layer reports the token is used, and must wipe all wallet sessions.
  await sessions.addSession(VALID_ADDRESS, jti, 3600);
  await sessions.addSession(VALID_ADDRESS, "other-session-jti", 3600);

  const familyId = "family-attack";

  mock.method(RefreshTokenModel, "findOne", async () => ({
    _id: "stored-id-1",
    tokenHash: "somehash",
    familyId,
    userId,
    used: true, // already consumed — replay attempt
    revoked: false,
  }));

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

  assert.strictEqual(revokedFamilyId, familyId);
  // Every session for the wallet must be wiped on reuse detection.
  assert.strictEqual(await sessions.isActive(jti), false);
  assert.strictEqual(await sessions.isActive("other-session-jti"), false);
});

test("AuthService.refreshTokens: revoked token returns 401", async () => {
  const secret = process.env.JWT_SECRET!;
  const jti = "refresh-jti-revoked";
  const payload = { sub: "user-id", wallet: VALID_ADDRESS, type: "refresh", jti };
  const refreshToken = jwt.sign(payload, secret);
  await sessions.addSession(VALID_ADDRESS, jti, 3600);

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
  const jti = "refresh-jti-unknown";
  const payload = { sub: "user-id", wallet: VALID_ADDRESS, type: "refresh", jti };
  const refreshToken = jwt.sign(payload, secret);
  await sessions.addSession(VALID_ADDRESS, jti, 3600);

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

  const accessPayload = { sub: "user-id", wallet: VALID_ADDRESS, type: "access", jti: "x" };
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

test("AuthService.refreshTokens: revoked JTI returns 401 before DB lookup", async () => {
  const secret = process.env.JWT_SECRET!;
  const jti = "refresh-jti-already-revoked";
  const payload = { sub: "user-id", wallet: VALID_ADDRESS, type: "refresh", jti };
  const refreshToken = jwt.sign(payload, secret);
  // JTI is NOT registered in the session store — simulates a token whose
  // session was wiped by DELETE /auth/sessions.

  await assert.rejects(
    () => authService.refreshTokens(refreshToken),
    (err: any) => err.status === 401 && err.message.includes("has been revoked")
  );
});

test("AuthService.logout: invalidates only the current session", async () => {
  await sessions.addSession(VALID_ADDRESS, "current-jti", 900);
  await sessions.addSession(VALID_ADDRESS, "other-device-jti", 900);

  await authService.logout("current-jti");

  assert.strictEqual(await sessions.isActive("current-jti"), false);
  assert.strictEqual(await sessions.isActive("other-device-jti"), true);
});

test("AuthService.revokeAllSessions: wipes every JTI for a wallet", async () => {
  await sessions.addSession(VALID_ADDRESS, "jti-a", 900);
  await sessions.addSession(VALID_ADDRESS, "jti-b", 900);
  await sessions.addSession(VALID_ADDRESS, "jti-c", 900);

  let updateFilter: any = null;
  mock.method(RefreshTokenModel, "updateMany", async (filter: any) => {
    updateFilter = filter;
    return { modifiedCount: 3 };
  });

  const count = await authService.revokeAllSessions(VALID_ADDRESS, "user-id");

  assert.strictEqual(count, 3);
  assert.strictEqual(await sessions.isActive("jti-a"), false);
  assert.strictEqual(await sessions.isActive("jti-b"), false);
  assert.strictEqual(await sessions.isActive("jti-c"), false);
  // Refresh-token side of the session is also wiped so /auth/refresh
  // cannot mint new tokens from any of the user's stored refresh tokens.
  assert.strictEqual(updateFilter.userId, "user-id");
});

test("AuthService.verifyAccessToken: valid token with active JTI", async () => {
  const secret = process.env.JWT_SECRET!;
  const jti = "access-jti-valid";
  const payload = { sub: "user-id", wallet: VALID_ADDRESS, type: "access", jti };
  const token = jwt.sign(payload, secret);
  await sessions.addSession(VALID_ADDRESS, jti, 900);

  const result = await authService.verifyAccessToken(token);

  assert.strictEqual(result.sub, "user-id");
  assert.strictEqual(result.type, "access");
  assert.strictEqual(result.jti, jti);
});

test("AuthService.verifyAccessToken: rejects token with revoked JTI", async () => {
  const secret = process.env.JWT_SECRET!;
  const jti = "access-jti-revoked";
  const payload = { sub: "user-id", wallet: VALID_ADDRESS, type: "access", jti };
  const token = jwt.sign(payload, secret);
  // JTI never registered, or removed by logout — middleware must reject.

  await assert.rejects(
    () => authService.verifyAccessToken(token),
    (err: any) => err.status === 401 && err.message.includes("revoked")
  );
});
