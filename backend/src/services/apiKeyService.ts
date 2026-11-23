/**
 * API Key Service (#1737)
 *
 * Manages the lifecycle of scoped API keys for third-party read access:
 * creation (with hashed storage), verification, rotation, revocation,
 * and per-key quota enforcement integrated with the shared rate-limit
 * package.
 *
 * Design:
 *   - Raw keys are generated as `ia_live_<32 random base62 chars>` and
 *     stored only as SHA-256 hashes. The raw key is returned exactly once
 *     on creation.
 *   - Per-key quotas are enforced using Redis (the same shared limiter
 *     infrastructure as IP/wallet rate limits), keyed by the key hash.
 *   - Scopes are read-only today: `read:*` grants all read routes. Future
 *     granular scopes can be added without changing the storage shape.
 *
 * Compatibility: adds new endpoints under /api/api-keys; no existing
 * endpoint's shape changes. The X-Api-Key middleware is additive and
 * runs only on routes that opt in.
 */

import { createHash, randomBytes } from "crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { ApiKeyModel, type ApiKeyDocument } from "../db/models/apiKey.model";
import { apiError } from "../utils/apiError";
import { redis } from "../cache/redisClient";
import { logger } from "../utils/logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ApiKeyView {
  id: string;
  keyPrefix: string;
  owner: string;
  ownerLabel: string | null;
  scopes: string[];
  quotaRequests: number;
  quotaWindowSeconds: number;
  status: "active" | "revoked" | "rotated";
  lastUsedAt: string | null;
  usageCount: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreateApiKeyInput {
  owner: string;
  ownerLabel?: string;
  scopes?: string[];
  quotaRequests?: number;
  quotaWindowSeconds?: number;
  expiresAt?: Date | null;
}

export interface CreateApiKeyResult {
  apiKey: ApiKeyView;
  /** The raw key — shown only once, never stored. */
  rawKey: string;
}

export interface ApiKeyAuthResult {
  valid: boolean;
  keyDoc: ApiKeyView | null;
  quotaExceeded: boolean;
  retryAfterSeconds: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const KEY_PREFIX = "ia_live_";

function generateRawKey(): string {
  const bytes = randomBytes(24);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = KEY_PREFIX;
  for (let i = 0; i < bytes.length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

function toView(doc: ApiKeyDocument): ApiKeyView {
  return {
    id: String(doc._id),
    keyPrefix: doc.keyPrefix,
    owner: doc.owner,
    ownerLabel: doc.ownerLabel ?? null,
    scopes: doc.scopes,
    quotaRequests: doc.quotaRequests,
    quotaWindowSeconds: doc.quotaWindowSeconds,
    status: doc.status,
    lastUsedAt: doc.lastUsedAt ? doc.lastUsedAt.toISOString() : null,
    usageCount: doc.usageCount,
    expiresAt: doc.expiresAt ? doc.expiresAt.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
  };
}

// ── Quota ─────────────────────────────────────────────────────────────────────

function quotaRedisKey(keyHash: string): string {
  return `apikey:quota:${keyHash}`;
}

async function checkAndConsumeQuota(
  keyHash: string,
  quotaRequests: number,
  quotaWindowSeconds: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const key = quotaRedisKey(keyHash);
  try {
    // Atomic increment + TTL in a single pipeline
    const pipeline = redis.multi();
    pipeline.incr(key);
    pipeline.expire(key, quotaWindowSeconds, "NX"); // set TTL only if not already set
    const results = await pipeline.exec();
    if (!results) return { allowed: true, retryAfterSeconds: 0 };

    const count = results[0]?.[1] as number;
    if (count > quotaRequests) {
      // Already consumed — compute retry-after from TTL
      const ttl = await redis.ttl(key);
      return {
        allowed: false,
        retryAfterSeconds: ttl > 0 ? ttl : quotaWindowSeconds,
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  } catch {
    // Redis unavailable — fail open (allow request) rather than block all API
    // key users when Redis is down. The rate-limit package has the same
    // philosophy.
    logger.warn({ keyHash: keyHash.slice(0, 16) }, "apikey_quota_check_failed_redis_unavailable");
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

export class ApiKeyService {
  /**
   * Create a new API key. The raw key is returned once and never stored.
   */
  async createKey(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
    if (!input.owner || input.owner.trim().length === 0) {
      throw apiError(400, "BAD_REQUEST", "owner is required");
    }

    const rawKey = generateRawKey();
    const keyHash = hashKey(rawKey);
    const keyPrefix = rawKey.slice(0, KEY_PREFIX.length + 8);

    const doc = await ApiKeyModel.create({
      keyHash,
      keyPrefix,
      owner: input.owner,
      ownerLabel: input.ownerLabel,
      scopes: input.scopes ?? ["read:*"],
      quotaRequests: input.quotaRequests ?? 100,
      quotaWindowSeconds: input.quotaWindowSeconds ?? 3600,
      status: "active",
      expiresAt: input.expiresAt ?? null,
    });

    return {
      apiKey: toView(doc),
      rawKey,
    };
  }

  /**
   * Authenticate an X-Api-Key header value. Returns whether the key is valid,
   * the key metadata, and whether the per-key quota has been exceeded.
   */
  async authenticate(rawKey: string): Promise<ApiKeyAuthResult> {
    if (!rawKey || rawKey.length < 10) {
      return { valid: false, keyDoc: null, quotaExceeded: false, retryAfterSeconds: 0 };
    }

    const keyHash = hashKey(rawKey);
    const doc = await ApiKeyModel.findOne({ keyHash }).catch(() => null);

    if (!doc) {
      return { valid: false, keyDoc: null, quotaExceeded: false, retryAfterSeconds: 0 };
    }

    if (doc.status !== "active") {
      return { valid: false, keyDoc: toView(doc), quotaExceeded: false, retryAfterSeconds: 0 };
    }

    if (doc.expiresAt && doc.expiresAt < new Date()) {
      return { valid: false, keyDoc: toView(doc), quotaExceeded: false, retryAfterSeconds: 0 };
    }

    // Check and consume quota
    const quota = await checkAndConsumeQuota(
      keyHash,
      doc.quotaRequests,
      doc.quotaWindowSeconds,
    );

    if (!quota.allowed) {
      return {
        valid: true,
        keyDoc: toView(doc),
        quotaExceeded: true,
        retryAfterSeconds: quota.retryAfterSeconds,
      };
    }

    // Update last-used timestamp and usage count (fire and forget)
    ApiKeyModel.updateOne(
      { _id: doc._id },
      {
        $set: { lastUsedAt: new Date() },
        $inc: { usageCount: 1 },
      },
    ).catch((err) => {
      logger.warn({ err }, "apikey_usage_update_failed");
    });

    return {
      valid: true,
      keyDoc: toView(doc),
      quotaExceeded: false,
      retryAfterSeconds: 0,
    };
  }

  /**
   * List all API keys for an owner (no raw keys returned).
   */
  async listKeys(owner: string): Promise<ApiKeyView[]> {
    const docs = await ApiKeyModel.find({ owner }).sort({ createdAt: -1 });
    return docs.map(toView);
  }

  /**
   * Revoke an API key. Once revoked it can never authenticate again.
   */
  async revokeKey(keyId: string, owner: string): Promise<ApiKeyView> {
    const doc = await ApiKeyModel.findOne({ _id: keyId, owner });
    if (!doc) {
      throw apiError(404, "NOT_FOUND", "API key not found");
    }
    doc.status = "revoked";
    await doc.save();
    return toView(doc);
  }

  /**
   * Rotate an API key: revoke the old key and issue a new one with the
   * same scopes and quota settings.
   */
  async rotateKey(keyId: string, owner: string): Promise<CreateApiKeyResult> {
    const oldDoc = await ApiKeyModel.findOne({ _id: keyId, owner });
    if (!oldDoc) {
      throw apiError(404, "NOT_FOUND", "API key not found");
    }
    if (oldDoc.status !== "active") {
      throw apiError(409, "CONFLICT", "Only active keys can be rotated");
    }

    // Revoke the old key
    oldDoc.status = "rotated";
    await oldDoc.save();

    // Create a new key with the same settings
    return this.createKey({
      owner: oldDoc.owner,
      ownerLabel: oldDoc.ownerLabel,
      scopes: oldDoc.scopes,
      quotaRequests: oldDoc.quotaRequests,
      quotaWindowSeconds: oldDoc.quotaWindowSeconds,
      expiresAt: oldDoc.expiresAt,
    });
  }
}

// ── Middleware ─────────────────────────────────────────────────────────────────

/**
 * Express middleware that authenticates X-Api-Key for read routes.
 *
 * Usage:
 *   router.get("/public-data", apiKeyAuth(apiKeyService), handler);
 *
 * On success, `req.apiKey` contains the key metadata for the handler.
 * On failure, returns 401 (invalid key) or 429 (quota exceeded).
 */
export function createApiKeyAuthMiddleware(service: ApiKeyService): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rawKey = req.headers["x-api-key"] as string | undefined;
    if (!rawKey) {
      next(apiError(401, "UNAUTHORIZED", "Missing X-Api-Key header"));
      return;
    }

    const result = await service.authenticate(rawKey);
    if (!result.valid) {
      next(apiError(401, "UNAUTHORIZED", "Invalid or revoked API key"));
      return;
    }

    if (result.quotaExceeded) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      res.setHeader("X-RateLimit-Remaining", "0");
      next(apiError(429, "RATE_LIMITED", "API key quota exceeded"));
      return;
    }

    // Attach to request for the handler
    (req as any).apiKey = result.keyDoc;
    next();
  };
}
