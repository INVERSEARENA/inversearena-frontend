import { test } from "node:test";
import assert from "node:assert";
import {
  createDecipheriv,
  createECDH,
  createHmac,
  generateKeyPairSync,
  randomBytes,
} from "crypto";
import { PushService, PushNotConfiguredError } from "../../src/services/pushService";

/**
 * Web Push delivery for time-critical round alerts (#1571).
 *
 * Covers encryption at rest, RFC 8291 payload round-trip, VAPID authed
 * delivery, scheduler dedup/preference/suppression semantics, and 404/410
 * subscription expiry.
 */

const ENCRYPTION_KEY = randomBytes(32);

const { publicKey: vapidPemPublic, privateKey: vapidPemPrivate } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// Extract the 65-byte uncompressed point from an SPKI PEM for the `k` param.
function uncompressedPoint(spkiPem: string): Buffer {
  const der = Buffer.from(
    spkiPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
    "base64",
  );
  // SPKI P-256: the last 65 bytes are the uncompressed point.
  return der.subarray(der.length - 65);
}

const VAPID = {
  publicKey: uncompressedPoint(vapidPemPublic).toString("base64url"),
  privateKey: vapidPemPrivate,
  subject: "mailto:ops@example.com",
};

function makeClientKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    ecdh,
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
}

function makePrisma(subscriptions: any[] = []) {
  const calls: { upsert: unknown[]; deleteMany: unknown[]; findMany: number } = {
    upsert: [],
    deleteMany: [],
    findMany: 0,
  };
  const prisma = {
    pushSubscription: {
      upsert: async (args: any) => {
        calls.upsert.push(args);
        return { id: "sub-1", endpoint: args.where.endpoint, createdAt: new Date() };
      },
      deleteMany: async (args: any) => {
        calls.deleteMany.push(args);
        return { count: 1 };
      },
      findMany: async () => {
        calls.findMany += 1;
        return subscriptions;
      },
    },
  } as any;
  return { prisma, calls };
}

function makePrefs(overrides: Record<string, unknown> = {}) {
  const calls: { markSent: number; markFailed: unknown[] } = { markSent: 0, markFailed: [] };
  const prefs = {
    shouldNotify: async () => true,
    hasDelivered: async () => false,
    recordDelivery: async () => "delivery-1",
    markSent: async () => {
      calls.markSent += 1;
    },
    markFailed: async (_id: string, error: string) => {
      calls.markFailed.push(error);
    },
    ...overrides,
  } as any;
  return { prefs, calls };
}

function makeService(opts: {
  subscriptions?: any[];
  prefsOverrides?: Record<string, unknown>;
  sender?: (endpoint: string, init: RequestInit) => Promise<Response>;
} = {}) {
  const { prisma, calls: prismaCalls } = makePrisma(opts.subscriptions);
  const { prefs, calls: prefsCalls } = makePrefs(opts.prefsOverrides);
  const sent: Array<{ endpoint: string; init: RequestInit }> = [];
  const sender =
    opts.sender ??
    (async (endpoint: string, init: RequestInit) => {
      sent.push({ endpoint, init });
      return { ok: true, status: 201 } as Response;
    });
  const service = new PushService(prisma, prefs, {
    sender,
    vapid: VAPID,
    encryptionKey: ENCRYPTION_KEY,
  });
  return { service, prismaCalls, prefsCalls, sent };
}

const MESSAGE = {
  title: "Round resolved",
  body: "Round 3 resolved — the next commit window is opening.",
  url: "/arena/arena-1",
  tag: "arena-arena-1-round-3-started",
};

/** Client-side RFC 8291 aes128gcm decrypt (mirrors the browser). */
function clientDecrypt(client: ReturnType<typeof makeClientKeys>, payload: Buffer): unknown {
  const salt = payload.subarray(0, 16);
  const rs = payload.readUInt32BE(16);
  assert.equal(rs, 4096);
  const keyIdLen = payload.readUInt8(20);
  assert.equal(keyIdLen, 65);
  const serverPublicKey = payload.subarray(21, 86);
  const ciphertext = payload.subarray(86);

  const sharedSecret = client.ecdh.computeSecret(serverPublicKey);
  const authSecret = Buffer.from(client.auth, "base64url");
  const clientPublicKey = Buffer.from(client.p256dh, "base64url");
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), clientPublicKey, serverPublicKey]);
  const prk = createHmac("sha256", authSecret).update(sharedSecret).digest();
  const expand = (info: Buffer, n: number) =>
    createHmac("sha256", prk)
      .update(Buffer.concat([info, Buffer.from([0x01])]))
      .digest()
      .subarray(0, n);
  const cek = expand(Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = expand(Buffer.from("Content-Encoding: nonce\0"), 12);

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(data), decipher.final()]);
  assert.equal(padded[padded.length - 1], 0x02);
  return JSON.parse(padded.subarray(0, padded.length - 1).toString("utf8"));
}

test("encrypts subscription keys at rest and round-trips them", () => {
  const { service } = makeService();
  const enc = service.encryptField("test-value");
  assert.notEqual(enc, "test-value");
  assert.equal(service.decryptField(enc), "test-value");

  const other = new PushService({} as any, {} as any, {
    vapid: VAPID,
    encryptionKey: randomBytes(32),
  });
  assert.throws(() => other.decryptField(enc), /bad decrypt|Unsupported state/);
});

test("createSubscription stores ciphertext, never plaintext", async () => {
  const { service, prismaCalls } = makeService();
  const client = makeClientKeys();
  await service.createSubscription("user-1", {
    endpoint: "https://push.example.com/sub/1",
    keys: { p256dh: client.p256dh, auth: client.auth },
  });
  const args = prismaCalls.upsert[0] as any;
  assert.equal(args.where.endpoint, "https://push.example.com/sub/1");
  assert.notEqual(args.create.p256dh, client.p256dh);
  assert.notEqual(args.create.auth, client.auth);
});

test("createSubscription rejects non-https endpoints", async () => {
  const { service } = makeService();
  await assert.rejects(
    () =>
      service.createSubscription("user-1", {
        endpoint: "http://push.example.com/sub/1",
        keys: { p256dh: "eA", auth: "eA" },
      }),
    /https/,
  );
});

test("throws PushNotConfiguredError without VAPID/encryption config", async () => {
  const { prisma } = makePrisma();
  const { prefs } = makePrefs();
  const unconfigured = new PushService(prisma, prefs, {
    sender: async () => ({ ok: true, status: 201 }) as Response,
  });
  await assert.rejects(
    () =>
      unconfigured.createSubscription("user-1", {
        endpoint: "https://push.example.com/sub/1",
        keys: { p256dh: "eA", auth: "eA" },
      }),
    PushNotConfiguredError,
  );
});

test("encrypts payloads the browser can decrypt (RFC 8291 round-trip)", () => {
  const { service } = makeService();
  const client = makeClientKeys();
  const payload = service.encryptMessageContent(
    { p256dh: client.p256dh, auth: client.auth },
    MESSAGE,
  );
  assert.deepEqual(clientDecrypt(client, payload), MESSAGE);
});

test("sendPush posts an aes128gcm body with a VAPID authorization header", async () => {
  const { service, sent } = makeService();
  const client = makeClientKeys();
  const stored = {
    id: "sub-1",
    userId: "user-1",
    endpoint: "https://push.example.com/sub/1",
    p256dh: service.encryptField(client.p256dh),
    auth: service.encryptField(client.auth),
    userAgent: null,
  };
  const outcome = await service.sendPush(stored, MESSAGE);
  assert.equal(outcome, "sent");
  assert.equal(sent.length, 1);
  const headers = sent[0]!.init.headers as Record<string, string>;
  assert.equal(headers["Content-Encoding"], "aes128gcm");
  assert.match(headers["Authorization"], /^vapid t=.+, k=.+/);
  // The encrypted body decrypts to the message on the client side.
  assert.deepEqual(clientDecrypt(client, sent[0]!.init.body as Buffer), MESSAGE);
});

test("sendPush reports expired on 404/410", async () => {
  for (const status of [404, 410]) {
    const { service } = makeService({
      sender: async () => ({ ok: false, status }) as Response,
    });
    const client = makeClientKeys();
    const stored = {
      id: "sub-1",
      userId: "user-1",
      endpoint: "https://push.example.com/sub/1",
      p256dh: service.encryptField(client.p256dh),
      auth: service.encryptField(client.auth),
      userAgent: null,
    };
    assert.equal(await service.sendPush(stored, MESSAGE), "expired");
  }
});

function storedSubscription(service: PushService, endpoint: string) {
  const client = makeClientKeys();
  return {
    id: "sub-1",
    userId: "user-1",
    endpoint,
    p256dh: service.encryptField(client.p256dh),
    auth: service.encryptField(client.auth),
    userAgent: null,
  };
}

test("scheduler sends once per (user, arena, round, type)", async () => {
  const seed = makeService();
  const sub = storedSubscription(seed.service, "https://push.example.com/sub/1");

  const { service: firstService, sent } = makeService({ subscriptions: [sub] });
  const input = {
    arenaId: "arena-1",
    roundNumber: 3,
    type: "round-started" as const,
    message: MESSAGE,
    userIds: ["user-1"],
  };
  const first = await firstService.scheduleRoundPhasePushes(input);
  assert.equal(first.sent, 1);
  assert.equal(sent.length, 1);

  // A repeat schedule for the same (arena, round, type) is a duplicate —
  // the ledger already holds a sent delivery, so the user is skipped.
  const { service: secondService } = makeService({
    subscriptions: [sub],
    prefsOverrides: { hasDelivered: async () => true },
  });
  const second = await secondService.scheduleRoundPhasePushes(input);
  assert.equal(second.sent, 0);
  assert.equal(second.skipped, 1);
});

test("scheduler honors user notification preferences", async () => {
  const { service } = makeService({
    subscriptions: [],
    prefsOverrides: { shouldNotify: async () => false },
  });
  const result = await service.scheduleRoundPhasePushes({
    arenaId: "arena-1",
    roundNumber: 3,
    type: "round-started",
    message: MESSAGE,
    userIds: ["user-1", "user-2"],
  });
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 2);
});

test("scheduler suppresses latency-bound warnings for very short rounds", async () => {
  const { service, sent } = makeService({ subscriptions: [] });
  const result = await service.scheduleRoundPhasePushes({
    arenaId: "arena-1",
    roundNumber: 3,
    type: "commit-closing",
    message: MESSAGE,
    userIds: ["user-1"],
    roundDurationSecs: 30,
  });
  assert.equal(result.suppressed, true);
  assert.equal(result.sent, 0);
  assert.equal(sent.length, 0);
});

test("scheduler removes subscriptions reported gone (404/410)", async () => {
  const { service, prismaCalls, prefsCalls } = makeService({
    sender: async () => ({ ok: false, status: 410 }) as Response,
  });
  const sub = storedSubscription(service, "https://push.example.com/gone");
  // Rebuild with the subscription present in storage.
  const inner = makePrisma([sub]);
  const { prefs } = makePrefs();
  const service2 = new PushService(inner.prisma, prefs, {
    sender: async () => ({ ok: false, status: 410 }) as Response,
    vapid: VAPID,
    encryptionKey: ENCRYPTION_KEY,
  });
  const result = await service2.scheduleRoundPhasePushes({
    arenaId: "arena-1",
    roundNumber: 3,
    type: "round-started",
    message: MESSAGE,
    userIds: ["user-1"],
  });
  assert.equal(result.sent, 0);
  assert.equal(result.expired, 1);
  assert.equal(inner.calls.deleteMany.length, 1);
  assert.equal(prefsCalls.markFailed.length, 0);
  void prismaCalls;
});
