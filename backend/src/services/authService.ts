import { randomBytes } from "crypto";
import jwt from "jsonwebtoken";
import { Keypair } from "@stellar/stellar-sdk";
import { NonceModel } from "../db/models/nonce.model";
import { UserModel } from "../db/models/user.model";
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

    const tokens = this.issueTokenPair(user._id.toString(), walletAddress);

    return {
      ...tokens,
      user: {
        id: user._id.toString(),
        walletAddress: user.walletAddress,
        displayName: user.displayName,
        joinedAt: user.joinedAt,
        lastLoginAt: user.lastLoginAt,
      },
    };
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

    return this.issueTokenPair(payload.sub, payload.wallet);
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

  private issueTokenPair(userId: string, walletAddress: string): TokenPair {
    const secret = getJwtSecret();
    const accessPayload: JwtPayload = { sub: userId, wallet: walletAddress, type: "access" };
    const refreshPayload: JwtPayload = { sub: userId, wallet: walletAddress, type: "refresh" };

    const accessToken = jwt.sign(accessPayload, secret, {
      expiresIn: (process.env.JWT_EXPIRES_IN ?? "15m") as jwt.SignOptions["expiresIn"],
    });
    const refreshToken = jwt.sign(refreshPayload, secret, {
      expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN ?? "7d") as jwt.SignOptions["expiresIn"],
    });

    return { accessToken, refreshToken };
  }
}
