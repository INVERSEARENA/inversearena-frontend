/**
 * #1456 — secret rotation readiness for JWT and webhook keys. Overlap windows
 * accept current and previous keys without accepting unknown key IDs.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { createHmac } from "crypto";
import express, { type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import request from "supertest";

import {
  MAX_OVERLAP_MS,
  SecretConfigError,
  checkRotationReadiness,
  fingerprintKid,
  getKeyring,
  loadKeyring,
  verificationCandidates,
} from "../src/config/secretKeyring";
import { assertSecretRotationReadiness } from "../src/config/validate";
import { errorHandler } from "../src/middleware/errorHandler";
import { verifyWebhookSignature, WEBHOOK_KEY_ID_HEADER } from "../src/middleware/verifyWebhook";
import { createOracleRouter } from "../src/routes/oracle";
import { AuthService } from "../src/services/authService";
import type { SessionStore } from "../src/cache/sessionStore";
import { register } from "../src/utils/metrics";

const NOW = new Date("2026-06-01T00:00:00Z");
const IN_ONE_DAY = new Date(NOW.getTime() + 24 * 3600 * 1000).toISOString();
const CURRENT = "c".repeat(40);
const PREVIOUS = "p".repeat(40);
const ROGUE = "r".repeat(40);

describe("checkRotationReadiness", () => {
  it("reports a stable single-key configuration", () => {
    const r = checkRotationReadiness("jwt", { JWT_SECRET: CURRENT }, NOW);
    expect(r).toMatchObject({ state: "stable", currentKid: fingerprintKid(CURRENT), previousKid: null, errors: [] });
  });

  it("reports an open overlap window", () => {
    const r = checkRotationReadiness("jwt", { JWT_SECRET: CURRENT, JWT_SECRET_PREVIOUS: PREVIOUS, JWT_SECRET_PREVIOUS_EXPIRES_AT: IN_ONE_DAY }, NOW);
    expect(r.state).toBe("rotating");
    expect(r.errors).toEqual([]);
    expect(r.previousKid).toBe(fingerprintKid(PREVIOUS));
  });

  const invalidCases: Array<[string, Record<string, string>, string]> = [
    ["missing current jwt secret", {}, "JWT_SECRET must be set"],
    ["short jwt secret", { JWT_SECRET: "short" }, "at least 32"],
    ["previous without expiry", { JWT_SECRET: CURRENT, JWT_SECRET_PREVIOUS: PREVIOUS }, "EXPIRES_AT is required"],
    ["expiry without previous", { JWT_SECRET: CURRENT, JWT_SECRET_PREVIOUS_EXPIRES_AT: IN_ONE_DAY }, "PREVIOUS is not"],
    ["unparseable expiry", { JWT_SECRET: CURRENT, JWT_SECRET_PREVIOUS: PREVIOUS, JWT_SECRET_PREVIOUS_EXPIRES_AT: "soon" }, "ISO-8601"],
    ["previous equal to current", { JWT_SECRET: CURRENT, JWT_SECRET_PREVIOUS: CURRENT, JWT_SECRET_PREVIOUS_EXPIRES_AT: IN_ONE_DAY }, "must differ"],
    ["colliding explicit kids", { JWT_SECRET: CURRENT, JWT_SECRET_KID: "k1", JWT_SECRET_PREVIOUS: PREVIOUS, JWT_SECRET_PREVIOUS_KID: "k1", JWT_SECRET_PREVIOUS_EXPIRES_AT: IN_ONE_DAY }, "must differ"],
    ["invalid kid characters", { JWT_SECRET: CURRENT, JWT_SECRET_KID: "bad kid!" }, "must match"],
    ["overlap longer than 30 days", { JWT_SECRET: CURRENT, JWT_SECRET_PREVIOUS: PREVIOUS, JWT_SECRET_PREVIOUS_EXPIRES_AT: new Date(NOW.getTime() + MAX_OVERLAP_MS + 1000).toISOString() }, "30 days"],
  ];
  it.each(invalidCases)("rejects %s", (_name, env, message) => {
    const r = checkRotationReadiness("jwt", env, NOW);
    expect(r.errors.join(" ")).toContain(message);
    expect(() => loadKeyring("jwt", env, NOW)).toThrow(SecretConfigError);
  });

  it("accepts an overlap window ending exactly at the 30-day boundary", () => {
    const env = { JWT_SECRET: CURRENT, JWT_SECRET_PREVIOUS: PREVIOUS, JWT_SECRET_PREVIOUS_EXPIRES_AT: new Date(NOW.getTime() + MAX_OVERLAP_MS).toISOString() };
    expect(checkRotationReadiness("jwt", env, NOW).errors).toEqual([]);
  });

  it("flags an expired previous key as a warning, not a boot failure", () => {
    const env = { JWT_SECRET: CURRENT, JWT_SECRET_PREVIOUS: PREVIOUS, JWT_SECRET_PREVIOUS_EXPIRES_AT: NOW.toISOString() };
    const r = checkRotationReadiness("jwt", env, NOW);
    expect(r.state).toBe("previous_expired");
    expect(r.errors).toEqual([]);
    expect(r.warnings[0]).toContain("remove it");
  });

  it("keeps short legacy webhook secrets bootable but warns", () => {
    const r = checkRotationReadiness("webhook", { ORACLE_WEBHOOK_SECRET: "short" }, NOW);
    expect(r.errors).toEqual([]);
    expect(r.warnings.length).toBe(1);
    expect(checkRotationReadiness("webhook", {}, NOW).errors).toEqual([]);
  });

  it("assertSecretRotationReadiness aggregates errors across purposes", () => {
    expect(() => assertSecretRotationReadiness({ JWT_SECRET: CURRENT, ORACLE_WEBHOOK_SECRET_PREVIOUS: PREVIOUS }, NOW)).toThrow(/ORACLE_WEBHOOK_SECRET_PREVIOUS is set/);
    expect(assertSecretRotationReadiness({ JWT_SECRET: CURRENT }, NOW).map((r) => r.state)).toEqual(["stable", "stable"]);
  });
});

describe("verificationCandidates", () => {
  const keyring = loadKeyring("jwt", { JWT_SECRET: CURRENT, JWT_SECRET_KID: "k2", JWT_SECRET_PREVIOUS: PREVIOUS, JWT_SECRET_PREVIOUS_KID: "k1", JWT_SECRET_PREVIOUS_EXPIRES_AT: IN_ONE_DAY }, NOW)!;

  it("selects exactly the key named by kid", () => {
    expect(verificationCandidates(keyring, "k2", NOW).map((k) => k.slot)).toEqual(["current"]);
    expect(verificationCandidates(keyring, "k1", NOW).map((k) => k.slot)).toEqual(["previous"]);
  });

  it("returns nothing for unknown kids", () => {
    expect(verificationCandidates(keyring, "k0", NOW)).toEqual([]);
    expect(verificationCandidates(keyring, "", NOW)).toEqual([]);
  });

  it("drops the previous key once the window closes (boundary is exclusive)", () => {
    const closed = new Date(IN_ONE_DAY);
    expect(verificationCandidates(keyring, "k1", closed)).toEqual([]);
    expect(verificationCandidates(keyring, undefined, closed).map((k) => k.slot)).toEqual(["current"]);
  });

  it("tries current then previous for legacy (kid-less) inputs", () => {
    expect(verificationCandidates(keyring, undefined, NOW).map((k) => k.slot)).toEqual(["current", "previous"]);
  });
});

// ---- JWT (AuthService) --------------------------------------------------------------

describe("AuthService JWT rotation", () => {
  const ORIGINAL = { ...process.env };
  const sessions = { isActive: async () => true } as unknown as SessionStore;
  const service = new AuthService(sessions);
  const claims = { sub: "u1", wallet: "G", type: "access", jti: "j1" };
  const future = () => new Date(Date.now() + 3600 * 1000).toISOString();

  function rotateTo(env: Record<string, string>) {
    for (const key of Object.keys(process.env)) if (key.startsWith("JWT_SECRET")) delete process.env[key];
    Object.assign(process.env, env);
  }

  beforeEach(() => rotateTo({ JWT_SECRET: CURRENT, JWT_SECRET_KID: "k2", JWT_SECRET_PREVIOUS: PREVIOUS, JWT_SECRET_PREVIOUS_KID: "k1", JWT_SECRET_PREVIOUS_EXPIRES_AT: future() }));
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith("JWT_SECRET")) delete process.env[key];
    Object.assign(process.env, ORIGINAL);
  });

  it("accepts tokens signed with the current and the previous key", async () => {
    await expect(service.verifyAccessToken(jwt.sign(claims, CURRENT, { keyid: "k2" }))).resolves.toMatchObject({ sub: "u1" });
    await expect(service.verifyAccessToken(jwt.sign(claims, PREVIOUS, { keyid: "k1" }))).resolves.toMatchObject({ sub: "u1" });
  });

  it("accepts legacy kid-less tokens from either key during the overlap", async () => {
    await expect(service.verifyAccessToken(jwt.sign(claims, PREVIOUS))).resolves.toMatchObject({ sub: "u1" });
  });

  it("rejects an unknown kid even when the signature matches a live key", async () => {
    await expect(service.verifyAccessToken(jwt.sign(claims, CURRENT, { keyid: "k-unknown" }))).rejects.toMatchObject({ status: 401 });
    const metrics = await register.getSingleMetricAsString("inversearena_secret_key_verifications_total");
    expect(metrics).toContain('purpose="jwt",slot="none",outcome="unknown_kid"');
  });

  it("rejects a token whose kid names one key but is signed with another", async () => {
    await expect(service.verifyAccessToken(jwt.sign(claims, PREVIOUS, { keyid: "k2" }))).rejects.toMatchObject({ status: 401 });
    await expect(service.verifyAccessToken(jwt.sign(claims, ROGUE))).rejects.toMatchObject({ status: 401 });
  });

  it("rejects the previous key once the window has closed", async () => {
    rotateTo({ JWT_SECRET: CURRENT, JWT_SECRET_KID: "k2", JWT_SECRET_PREVIOUS: PREVIOUS, JWT_SECRET_PREVIOUS_KID: "k1", JWT_SECRET_PREVIOUS_EXPIRES_AT: new Date(Date.now() - 1000).toISOString() });
    await expect(service.verifyAccessToken(jwt.sign(claims, PREVIOUS, { keyid: "k1" }))).rejects.toMatchObject({ status: 401 });
    await expect(service.verifyAccessToken(jwt.sign(claims, PREVIOUS))).rejects.toMatchObject({ status: 401 });
  });

  it("rejects the 'none' algorithm", async () => {
    const unsigned = jwt.sign(claims, "", { algorithm: "none" });
    await expect(service.verifyAccessToken(unsigned)).rejects.toMatchObject({ status: 401 });
  });

  it("picks up a rotated env without a restart (keyring cache invalidation)", async () => {
    const before = getKeyring("jwt")!.current.kid;
    rotateTo({ JWT_SECRET: ROGUE });
    expect(getKeyring("jwt")!.current.kid).not.toBe(before);
    await expect(service.verifyAccessToken(jwt.sign(claims, CURRENT, { keyid: "k2" }))).rejects.toMatchObject({ status: 401 });
  });
});

// ---- Webhook ------------------------------------------------------------------------

function hmac(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("webhook rotation (integration through the oracle route)", () => {
  const ORIGINAL = { ...process.env };
  const body = JSON.stringify({ currentAPY: 5.5 });

  function buildApp() {
    const app = express();
    app.use("/api/oracle", express.json({ verify: (req, _res, buf) => { (req as Request).rawBody = Buffer.from(buf); } }));
    app.use("/api/oracle", createOracleRouter());
    app.use(errorHandler);
    return app;
  }

  beforeEach(() => {
    Object.assign(process.env, {
      ORACLE_WEBHOOK_SECRET: CURRENT,
      ORACLE_WEBHOOK_SECRET_KID: "w2",
      ORACLE_WEBHOOK_SECRET_PREVIOUS: PREVIOUS,
      ORACLE_WEBHOOK_SECRET_PREVIOUS_KID: "w1",
      ORACLE_WEBHOOK_SECRET_PREVIOUS_EXPIRES_AT: new Date(Date.now() + 3600 * 1000).toISOString(),
    });
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith("ORACLE_WEBHOOK_SECRET")) delete process.env[key];
    Object.assign(process.env, ORIGINAL);
  });

  const post = (app: express.Express, signature: string, kid?: string) => {
    const req = request(app).post("/api/oracle/yield").set("content-type", "application/json").set("x-oracle-signature", signature);
    if (kid !== undefined) req.set(WEBHOOK_KEY_ID_HEADER, kid);
    return req.send(body);
  };

  it("rejects unknown kids and wrong keys with the same 401 as a bad signature", async () => {
    const app = buildApp();
    const unknown = await post(app, hmac(CURRENT, body), "w9");
    const rogue = await post(app, hmac(ROGUE, body));
    const mismatched = await post(app, hmac(PREVIOUS, body), "w2");
    for (const res of [unknown, rogue, mismatched]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    }
  });

  it("previous key stops working after the window closes", async () => {
    process.env.ORACLE_WEBHOOK_SECRET_PREVIOUS_EXPIRES_AT = new Date(Date.now() - 1000).toISOString();
    const res = await post(buildApp(), hmac(PREVIOUS, body));
    expect(res.status).toBe(401);
  });
});

describe("verifyWebhookSignature unit", () => {
  const keyring = loadKeyring("webhook", {
    ORACLE_WEBHOOK_SECRET: CURRENT,
    ORACLE_WEBHOOK_SECRET_PREVIOUS: PREVIOUS,
    ORACLE_WEBHOOK_SECRET_PREVIOUS_EXPIRES_AT: new Date(Date.now() + 3600 * 1000).toISOString(),
  })!;

  function run(signature: string, kid?: string) {
    const rawBody = Buffer.from("{}");
    const headers: Record<string, string> = { "x-oracle-signature": signature };
    if (kid) headers[WEBHOOK_KEY_ID_HEADER] = kid;
    let arg: unknown = "not-called";
    verifyWebhookSignature(keyring)({ headers, rawBody } as unknown as Request, {} as Response, (err?: unknown) => { arg = err; });
    return arg;
  }

  it("accepts current and previous keys, with or without their fingerprint kid", () => {
    expect(run(hmac(CURRENT, "{}"))).toBeUndefined();
    expect(run(hmac(PREVIOUS, "{}"))).toBeUndefined();
    expect(run(hmac(PREVIOUS, "{}"), fingerprintKid(PREVIOUS))).toBeUndefined();
  });

  it("is idempotent across duplicate deliveries", () => {
    const sig = hmac(PREVIOUS, "{}");
    expect(run(sig)).toBeUndefined();
    expect(run(sig)).toBeUndefined();
  });

  it("still accepts a plain secret string (legacy call sites)", () => {
    let arg: unknown = "not-called";
    verifyWebhookSignature(CURRENT)({ headers: { "x-oracle-signature": hmac(CURRENT, "{}") }, rawBody: Buffer.from("{}") } as unknown as Request, {} as Response, (err?: unknown) => { arg = err; });
    expect(arg).toBeUndefined();
  });
});
