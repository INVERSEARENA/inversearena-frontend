import { createCipheriv, createDecipheriv, createECDH, createHmac, randomBytes } from "crypto";
import type { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { NotificationPreferencesService } from "./notificationPreferencesService";
import { logger } from "../utils/logger";
import { env } from "../config/env";

/**
 * Web Push delivery for time-critical round phase alerts (#1571).
 *
 * - Subscriptions are bound to the authenticated wallet (`userId`) and
 *   support multiple devices per wallet (one row per push endpoint).
 * - The subscription `p256dh`/`auth` keys are AES-256-GCM encrypted at rest
 *   with `PUSH_ENCRYPTION_KEY`; the service never returns them to clients.
 * - Payloads use RFC 8291 `aes128gcm` content encoding with VAPID
 *   authentication, so the service worker receives `{title, body, url, tag}`
 *   and click-through opens the arena deep link.
 * - The scheduler deduplicates per (user, arena, round, type) via the
 *   delivery ledger, honors user notification preferences, suppresses
 *   latency-bound warnings for very short rounds, and removes subscriptions
 *   the push service reports as gone (404/410).
 */

export class PushNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushNotConfiguredError";
  }
}

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

export interface StoredPushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Deep link opened on notification click (e.g. `/arena/<id>`). */
  url: string;
  /** Deduplicates visible notifications on the device. */
  tag: string;
}

/** Round phase alert kinds the scheduler can emit. */
export type PushAlertType =
  | "round-started"
  | "commit-closing"
  | "reveal-open"
  | "you-won"
  | "refund-available";

export interface SchedulePushesInput {
  arenaId: string;
  roundNumber: number;
  type: PushAlertType;
  message: PushMessage;
  /** Wallet user IDs to notify (arena participants). */
  userIds: string[];
  /** Wall-clock length of the round in seconds, when known. */
  roundDurationSecs?: number;
  /**
   * Warnings whose window is shorter than this are suppressed: push latency
   * would exceed the window, so delivery is misleading (#1571 edge case).
   * Defaults to 60s for `commit-closing`, ignored for other types.
   */
  minDurationSecs?: number;
}

export interface SchedulePushesResult {
  sent: number;
  failed: number;
  /** Subscriptions removed after 404/410 from the push service. */
  expired: number;
  /** Users skipped by preference or prior delivery. */
  skipped: number;
  suppressed: boolean;
}

type Sender = (endpoint: string, init: RequestInit) => Promise<Response>;

interface PushServiceDeps {
  prisma: PrismaClient;
  prefs: NotificationPreferencesService;
  sender?: Sender;
  vapid?: { publicKey: string; privateKey: string; subject: string };
  encryptionKey?: Buffer;
}

const ENCRYPTION_PREFIX = "v1";

function vapidConfigFromEnv(): PushServiceDeps["vapid"] {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  const subject = env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return undefined;
  return { publicKey, privateKey, subject };
}

function encryptionKeyFromEnv(): Buffer | undefined {
  const raw = env.PUSH_ENCRYPTION_KEY;
  if (!raw) return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new PushNotConfiguredError(
      "PUSH_ENCRYPTION_KEY must be 32 random bytes as 64 hex characters",
    );
  }
  return Buffer.from(raw, "hex");
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function base64UrlEncode(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Single-round HKDF-Expand (RFC 8291 §3.2: L <= 32 always fits in T(1)). */
function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  return createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([0x01])]))
    .digest()
    .subarray(0, length);
}

export class PushService {
  private readonly sender: Sender;
  private readonly vapid: { publicKey: string; privateKey: string; subject: string } | undefined;
  private readonly encryptionKey: Buffer | undefined;

  constructor(private prisma: PrismaClient, private prefs: NotificationPreferencesService, deps?: Partial<Pick<PushServiceDeps, "sender" | "vapid" | "encryptionKey">>) {
    this.sender =
      deps?.sender ??
      ((endpoint, init) => fetch(endpoint, init));
    this.vapid = deps?.vapid ?? vapidConfigFromEnv();
    this.encryptionKey =
      deps?.encryptionKey !== undefined ? deps.encryptionKey : encryptionKeyFromEnv();
  }

  private requireVapid() {
    if (!this.vapid) {
      throw new PushNotConfiguredError(
        "Web Push is not configured (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT)",
      );
    }
    return this.vapid;
  }

  private requireEncryptionKey(): Buffer {
    if (!this.encryptionKey) {
      throw new PushNotConfiguredError(
        "Web Push storage is not configured (PUSH_ENCRYPTION_KEY)",
      );
    }
    return this.encryptionKey;
  }

  // ── Subscription storage (keys encrypted at rest) ───────────────────

  encryptField(plaintext: string): string {
    const key = this.requireEncryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [ENCRYPTION_PREFIX, iv.toString("base64"), ciphertext.toString("base64"), tag.toString("base64")].join(":");
  }

  decryptField(payload: string): string {
    const key = this.requireEncryptionKey();
    const [prefix, ivB64, ctB64, tagB64] = payload.split(":");
    if (prefix !== ENCRYPTION_PREFIX || !ivB64 || !ctB64 || !tagB64) {
      throw new Error("Unrecognized encrypted push field format");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return decipher.update(Buffer.from(ctB64, "base64"), undefined, "utf8") + decipher.final("utf8");
  }

  private validateSubscriptionPayload(payload: PushSubscriptionPayload): void {
    let endpointUrl: URL;
    try {
      endpointUrl = new URL(payload.endpoint);
    } catch {
      throw new Error("Invalid push endpoint URL");
    }
    if (endpointUrl.protocol !== "https:") {
      throw new Error("Push endpoint must use https");
    }
    if (payload.endpoint.length > 2000) throw new Error("Push endpoint too long");
    for (const [name, value] of Object.entries(payload.keys)) {
      if (typeof value !== "string" || value.length === 0 || value.length > 256) {
        throw new Error(`Invalid push subscription key: ${name}`);
      }
      // Must be valid base64url (p256dh 65B uncompressed key, auth 16B secret).
      base64UrlDecode(value);
    }
  }

  async createSubscription(
    userId: string,
    payload: PushSubscriptionPayload,
  ): Promise<{ id: string; endpoint: string; createdAt: Date }> {
    this.requireVapid();
    this.validateSubscriptionPayload(payload);
    const userAgent =
      payload.userAgent !== undefined ? payload.userAgent.slice(0, 512) : undefined;
    const record = await this.prisma.pushSubscription.upsert({
      where: { endpoint: payload.endpoint },
      create: {
        userId,
        endpoint: payload.endpoint,
        p256dh: this.encryptField(payload.keys.p256dh),
        auth: this.encryptField(payload.keys.auth),
        ...(userAgent !== undefined ? { userAgent } : {}),
      },
      update: {
        userId,
        p256dh: this.encryptField(payload.keys.p256dh),
        auth: this.encryptField(payload.keys.auth),
        ...(userAgent !== undefined ? { userAgent } : {}),
      },
      select: { id: true, endpoint: true, createdAt: true },
    });
    return record;
  }

  async deleteSubscription(userId: string, endpoint: string): Promise<boolean> {
    const result = await this.prisma.pushSubscription.deleteMany({
      where: { userId, endpoint },
    });
    return result.count > 0;
  }

  async listSubscriptions(
    userId: string,
  ): Promise<Array<{ id: string; endpoint: string; userAgent: string | null; createdAt: Date }>> {
    return this.prisma.pushSubscription.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, endpoint: true, userAgent: true, createdAt: true },
    });
  }

  // ── Web Push delivery (RFC 8291 aes128gcm + VAPID) ───────────────────

  /**
   * Encrypt a JSON message for one subscription (RFC 8291 `aes128gcm`).
   * Exported for unit tests; prefer {@link sendPush} in production paths.
   */
  encryptMessageContent(subscription: Pick<StoredPushSubscription, "p256dh" | "auth">, message: PushMessage): Buffer {
    const plaintext = Buffer.from(JSON.stringify(message), "utf8");
    if (plaintext.length > 3800) {
      throw new Error("Push message too large for a single Web Push record");
    }
    const clientPublicKey = base64UrlDecode(subscription.p256dh);
    if (clientPublicKey.length !== 65 || clientPublicKey[0] !== 0x04) {
      throw new Error("Invalid subscription p256dh key (expected 65-byte uncompressed P-256)");
    }
    const authSecret = base64UrlDecode(subscription.auth);
    if (authSecret.length !== 16) {
      throw new Error("Invalid subscription auth secret (expected 16 bytes)");
    }

    const serverECDH = createECDH("prime256v1");
    serverECDH.generateKeys();
    const serverPublicKey = serverECDH.getPublicKey();
    const sharedSecret = serverECDH.computeSecret(clientPublicKey);

    const keyInfo = Buffer.concat([
      Buffer.from("WebPush: info\0", "utf8"),
      clientPublicKey,
      serverPublicKey,
    ]);
    const prk = createHmac("sha256", authSecret).update(sharedSecret).digest();
    const cek = hkdfExpand(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0", "utf8")]), 16);
    const nonce = hkdfExpand(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0", "utf8")]), 12);

    const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);
    const cipher = createCipheriv("aes-128-gcm", cek, nonce);
    const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
    const salt = randomBytes(16);

    const header = Buffer.alloc(16 + 4 + 1 + 65);
    salt.copy(header, 0);
    header.writeUInt32BE(4096, 16);
    header.writeUInt8(65, 20);
    serverPublicKey.copy(header, 21);
    return Buffer.concat([header, ciphertext]);
  }

  private buildVapidAuthHeader(endpoint: string): string {
    const vapid = this.requireVapid();
    const audience = new URL(endpoint).origin;
    const token = jwt.sign(
      { aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: vapid.subject },
      vapid.privateKey,
      { algorithm: "ES256" },
    );
    return `vapid t=${token}, k=${vapid.publicKey}`;
  }

  /**
   * Send one push message. Returns `"sent"`, or `"expired"` when the push
   * service reports the subscription gone (caller must delete it).
   */
  async sendPush(
    subscription: StoredPushSubscription,
    message: PushMessage,
  ): Promise<"sent" | "expired"> {
    const decrypted = {
      p256dh: this.decryptField(subscription.p256dh),
      auth: this.decryptField(subscription.auth),
    };
    let body: Buffer;
    try {
      body = this.encryptMessageContent(decrypted, message);
    } catch {
      // Keys the push service can never use are equivalent to gone.
      return "expired";
    }
    const response = await this.sender(subscription.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        TTL: "2419200",
        Authorization: this.buildVapidAuthHeader(subscription.endpoint),
        Urgency: "high",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: body as any,
    });
    if (response.status === 404 || response.status === 410) return "expired";
    if (!response.ok) {
      throw new Error(`Push service responded with status ${response.status}`);
    }
    return "sent";
  }

  // ── Scheduler ───────────────────────────────────────────────────────

  private dedupeKey(arenaId: string, roundNumber: number, type: PushAlertType): string {
    return `push:${arenaId}:${roundNumber}:${type}`;
  }

  /**
   * Fan out a round phase alert to subscribed wallets (#1571).
   *
   * Per user the alert is sent at most once per (arena, round, type):
   * preferences are checked first, then the delivery ledger, then each of
   * the wallet's devices is sent to. Expired subscriptions (404/410) are
   * removed. Never throws for per-user/per-device failures — they are
   * counted in the result.
   */
  async scheduleRoundPhasePushes(input: SchedulePushesInput): Promise<SchedulePushesResult> {
    const result: SchedulePushesResult = {
      sent: 0,
      failed: 0,
      expired: 0,
      skipped: 0,
      suppressed: false,
    };

    const minDuration = input.minDurationSecs ?? (input.type === "commit-closing" ? 60 : 0);
    if (
      minDuration > 0 &&
      typeof input.roundDurationSecs === "number" &&
      input.roundDurationSecs < minDuration
    ) {
      // Push latency would exceed the window — delivering would mislead.
      result.suppressed = true;
      return result;
    }

    let vapid: { publicKey: string; privateKey: string; subject: string };
    try {
      vapid = this.requireVapid();
    } catch (err) {
      logger.warn(
        { subsystem: "push", err: err instanceof Error ? err.message : String(err) },
        "Push scheduler skipped: Web Push not configured",
      );
      result.suppressed = true;
      return result;
    }
    void vapid;

    const dedupeKey = this.dedupeKey(input.arenaId, input.roundNumber, input.type);

    for (const userId of new Set(input.userIds)) {
      try {
        const allowed = await this.prefs.shouldNotify(userId, "round", "push");
        if (!allowed) {
          result.skipped += 1;
          continue;
        }
        if (await this.prefs.hasDelivered(userId, dedupeKey, "push")) {
          result.skipped += 1;
          continue;
        }
        const deliveryId = await this.prefs.recordDelivery(userId, "round", "push", dedupeKey);

        const subscriptions = await this.prisma.pushSubscription.findMany({
          where: { userId },
          select: { id: true, userId: true, endpoint: true, p256dh: true, auth: true, userAgent: true },
        });
        if (subscriptions.length === 0) {
          result.skipped += 1;
          await this.prefs.markFailed(deliveryId, "no push subscriptions").catch(() => {});
          continue;
        }

        let anySent = false;
        for (const subscription of subscriptions) {
          try {
            const outcome = await this.sendPush(
              subscription as StoredPushSubscription,
              input.message,
            );
            if (outcome === "expired") {
              result.expired += 1;
              await this.prisma.pushSubscription
                .deleteMany({ where: { userId, endpoint: subscription.endpoint } })
                .catch(() => {});
              continue;
            }
            anySent = true;
            result.sent += 1;
          } catch (err) {
            result.failed += 1;
            logger.warn(
              {
                subsystem: "push",
                userId,
                endpoint: subscription.endpoint,
                err: err instanceof Error ? err.message : String(err),
              },
              "Push delivery failed",
            );
          }
        }

        if (anySent) {
          await this.prefs.markSent(deliveryId).catch(() => {});
        } else {
          await this.prefs.markFailed(deliveryId, "all devices failed or expired").catch(() => {});
        }
      } catch (err) {
        result.failed += 1;
        logger.warn(
          { subsystem: "push", userId, err: err instanceof Error ? err.message : String(err) },
          "Push scheduling failed for user",
        );
      }
    }

    return result;
  }
}
