import { randomBytes, randomUUID } from "crypto";
import { createHash } from "crypto";
import jwt from "jsonwebtoken";
import { Keypair } from "@stellar/stellar-sdk";
import { NonceModel } from "../db/models/nonce.model";
import { UserModel } from "../db/models/user.model";
import { RefreshTokenModel, generateFamilyId } from "../db/models/refreshToken.model";
import { SessionStore, sessionStore as defaultSessionStore } from "../cache/sessionStore";
import type { AuthUser, JwtPayload, TokenPair } from "../types/auth";

const NONCE_PREFIX = "Sign this message to authenticate with InverseArena:\n";

const PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be set and at least 32 characters");
  }
  return secret;
}

function nonceTtlSeconds(): number {
  const val = Number(process.env.NONCE_TTL_SECONDS);
  return Number.isFinite(val) && val > 0 ? val : 300;
}

function refreshTokenTtlSeconds(): number {
  const val = Number(process.env.JWT_REFRESH_EXPIRES_IN);
  if (typeof val === "number" && Number.isFinite(val) && val > 0) return val;
  // Default 7 days
  return 7 * 24 * 60 * 60;
}

function accessTokenTtlSeconds(): number {
  const val = Number(process.env.JWT_ACCESS_EXPIRES_IN);
  if (typeof val === "number" && Number.isFinite(val) && val > 0) return val;
  // Default 15 minutes
  return 15 * 60;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function validateWalletAddress(walletAddress: string): void {
  if (!PUBLIC_KEY_REGEX.test(walletAddress)) {
    const err = Object.assign(new Error("Invalid Stellar wallet address"), { status: 400 });
    throw err;
  }
}

export class AuthService {
  constructor(private readonly sessions: SessionStore = defaultSessionStore) {}

  async requestNonce(walletAddress: string): Promise<{ nonce: string; expiresAt: Date }> {
    validateWalletAddress(walletAddress);

    const rawHex = randomBytes(32).toString("hex");
    const nonce = `${NONCE_PREFIX}${rawHex}`;
    const expiresAt = new Date(Date.now() + nonceTtlSeconds() * 1000);

    await NonceModel.updateMany(
      { walletAddress, used: false, expiresAt: { $gt: new Date() } },
      { $set: { used: true } },
    );

    await NonceModel.create({ walletAddress, nonce, used: false, expiresAt });

    return { nonce, expiresAt };
  }

  async verifySignatureAndLogin(
    walletAddress: string,
    signature: string
  ): Promise<TokenPair & { user: AuthUser }> {
    validateWalletAddress(walletAddress);

    const nonceRecord = await NonceModel.findOne({
      walletAddress,
      used: false,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });

    if (!nonceRecord) {
      const err = Object.assign(
        new Error("No valid nonce found — request a new one"),
        { status: 401 }
      );
      throw err;
    }

    let valid = false;
    try {
      const keypair = Keypair.fromPublicKey(walletAddress);
      const messageBuffer = Buffer.from(nonceRecord.nonce, "utf-8");
      const signatureBuffer = Buffer.from(signature, "base64");
      valid = keypair.verify(messageBuffer, signatureBuffer);
    } catch {
      valid = false;
    }

    if (!valid) {
      const err = Object.assign(new Error("Invalid signature"), { status: 401 });
      throw err;
    }

    await NonceModel.findByIdAndUpdate(nonceRecord._id, { used: true });

    const now = new Date();
    const user = await UserModel.findOneAndUpdate(
      { walletAddress },
      { $set: { lastLoginAt: now }, $setOnInsert: { walletAddress, joinedAt: now } },
      { upsert: true, new: true }
    );

    const tokens = await this.issueTokenPair(user._id.toString(), walletAddress);

    const authUser: AuthUser = {
      id: user._id.toString(),
      walletAddress: user.walletAddress,
      joinedAt: user.joinedAt,
      lastLoginAt: user.lastLoginAt,
      ...(user.displayName !== undefined && user.displayName !== null
        ? { displayName: user.displayName }
        : {}),
    };

    return { ...tokens, user: authUser };
  }

  async refreshTokens(refreshToken: string): Promise<TokenPair> {
    let payload: JwtPayload;
    try {
      payload = jwt.verify(refreshToken, getJwtSecret()) as JwtPayload;
    } catch {
      const err = Object.assign(new Error("Invalid or expired refresh token"), { status: 401 });
      throw err;
    }

    if (payload.type !== "refresh") {
      const err = Object.assign(new Error("Token is not a refresh token"), { status: 401 });
      throw err;
    }

    // A token whose JTI has been revoked (logout / revoke-all) is rejected
    // even if its signature and DB row still look valid.
    if (payload.jti && !(await this.sessions.isActive(payload.jti))) {
      const err = Object.assign(new Error("Refresh token has been revoked"), { status: 401 });
      throw err;
    }

    const tokenHash = hashToken(refreshToken);
    const storedToken = await RefreshTokenModel.findOne({ tokenHash });

    if (!storedToken) {
      const err = Object.assign(new Error("Refresh token has been revoked or expired"), { status: 401 });
      throw err;
    }

    if (storedToken.revoked) {
      const err = Object.assign(new Error("Refresh token has been revoked"), { status: 401 });
      throw err;
    }

    if (storedToken.used) {
      // Token reuse detected — this is a theft attempt.
      // Revoke all tokens in this family and wipe the wallet's active JTIs.
      await RefreshTokenModel.updateMany(
        { familyId: storedToken.familyId },
        { $set: { revoked: true } }
      );
      await this.sessions.removeAllSessions(payload.wallet);
      const err = Object.assign(
        new Error("Refresh token reuse detected — all sessions invalidated"),
        { status: 401 }
      );
      throw err;
    }

    // Mark the presented token as used and retire its JTI so the same
    // refresh token cannot be replayed against the new access token.
    await RefreshTokenModel.findByIdAndUpdate(storedToken._id, { used: true });
    if (payload.jti) {
      await this.sessions.removeSession(payload.jti);
    }

    // Issue a new token pair in the same family
    return this.issueTokenPair(payload.sub, payload.wallet, storedToken.familyId);
  }

  /**
   * Invalidate a single session. The middleware passes the access token's
   * jti so only the current device/browser is logged out; other active
   * sessions for this wallet remain valid.
   */
  async logout(jti: string): Promise<void> {
    await this.sessions.removeSession(jti);
  }

  /**
   * Invalidate every session for a wallet. Called from
   * DELETE /auth/sessions when a wallet is compromised, rotated, or the
   * user wants a full sign-out. Also revokes all of the user's refresh
   * tokens so the refresh endpoint cannot mint new sessions.
   */
  async revokeAllSessions(walletAddress: string, userId: string): Promise<number> {
    const revokedCount = await this.sessions.removeAllSessions(walletAddress);
    await RefreshTokenModel.updateMany(
      { userId, revoked: false },
      { $set: { revoked: true } }
    );
    return revokedCount;
  }

  async verifyAccessToken(token: string): Promise<JwtPayload> {
    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, getJwtSecret()) as JwtPayload;
    } catch {
      const err = Object.assign(new Error("Invalid or expired access token"), { status: 401 });
      throw err;
    }

    if (payload.type !== "access") {
      const err = Object.assign(new Error("Token is not an access token"), { status: 401 });
      throw err;
    }

    // Reject tokens whose JTI has been invalidated server-side. This is the
    // mechanism that lets POST /auth/logout and DELETE /auth/sessions take
    // effect immediately instead of waiting for the JWT to expire.
    if (!payload.jti || !(await this.sessions.isActive(payload.jti))) {
      const err = Object.assign(new Error("Session has been revoked"), { status: 401 });
      throw err;
    }

    return payload;
  }

  private async issueTokenPair(
    userId: string,
    walletAddress: string,
    existingFamilyId?: string
  ): Promise<TokenPair> {
    const secret = getJwtSecret();
    const accessTtl = accessTokenTtlSeconds();
    const refreshTtl = refreshTokenTtlSeconds();
    const accessJti = randomUUID();
    const refreshJti = randomUUID();

    const accessPayload: JwtPayload = {
      sub: userId,
      wallet: walletAddress,
      type: "access",
      jti: accessJti,
    };
    const refreshPayload: JwtPayload = {
      sub: userId,
      wallet: walletAddress,
      type: "refresh",
      jti: refreshJti,
    };

    const accessToken = jwt.sign(accessPayload, secret, { expiresIn: accessTtl });
    const refreshToken = jwt.sign(refreshPayload, secret, { expiresIn: refreshTtl });

    // Persist the refresh token (hashed) for the family-based rotation
    // checks in `refreshTokens`. The DB is the durable record; Redis is the
    // fast-revocation index.
    await RefreshTokenModel.create({
      tokenHash: hashToken(refreshToken),
      familyId: existingFamilyId ?? generateFamilyId(),
      userId,
      used: false,
      revoked: false,
      expiresAt: new Date(Date.now() + refreshTtl * 1000),
    });

    // Register both JTIs in Redis so they can be revoked individually
    // (logout) or wholesale (revoke-all-sessions). The TTL on each key
    // matches the JWT lifetime, so expired tokens disappear automatically.
    await this.sessions.addSession(walletAddress, accessJti, accessTtl);
    await this.sessions.addSession(walletAddress, refreshJti, refreshTtl);

    return { accessToken, refreshToken };
  }
}
