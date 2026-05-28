import { randomBytes, randomUUID } from "crypto";
import { createHash } from "crypto";
import jwt from "jsonwebtoken";
import { Keypair } from "@stellar/stellar-sdk";
import { NonceModel } from "../db/models/nonce.model";
import { UserModel } from "../db/models/user.model";
import { RefreshTokenModel } from "../db/models/refreshToken.model";
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
  async requestNonce(walletAddress: string): Promise<{ nonce: string; expiresAt: Date }> {
    validateWalletAddress(walletAddress);

    const rawHex = randomBytes(32).toString("hex");
    const nonce = `${NONCE_PREFIX}${rawHex}`;
    const expiresAt = new Date(Date.now() + nonceTtlSeconds() * 1000);

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
      // Revoke all tokens in this family.
      await RefreshTokenModel.updateMany(
        { familyId: storedToken.familyId },
        { $set: { revoked: true } }
      );
      const err = Object.assign(
        new Error("Refresh token reuse detected — all sessions invalidated"),
        { status: 401 }
      );
      throw err;
    }

    // Mark the presented token as used
    await RefreshTokenModel.findByIdAndUpdate(storedToken._id, { used: true });

    // Issue a new token pair in the same family
    return this.issueTokenPair(payload.sub, payload.wallet, storedToken.familyId);
  }

  async logout(userId: string): Promise<void> {
    await RefreshTokenModel.updateMany(
      { userId, revoked: false },
      { $set: { revoked: true } }
    );
  }

  verifyAccessToken(token: string): JwtPayload {
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

    return payload;
  }

  private async issueTokenPair(
    userId: string,
    walletAddress: string,
    existingFamilyId?: string
  ): Promise<TokenPair> {
    const secret = getJwtSecret();
    const accessPayload: JwtPayload = { sub: userId, wallet: walletAddress, type: "access" };
    const refreshPayload: JwtPayload = { sub: userId, wallet: walletAddress, type: "refresh" };



    return { accessToken, refreshToken };
  }
}

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)\s*(s|m|h|d)$/);
  if (!match) return 7 * 24 * 60 * 60; // default 7 days
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s": return value;
    case "m": return value * 60;
    case "h": return value * 3600;
    case "d": return value * 86400;
    default: return 7 * 24 * 60 * 60;
  }
}
