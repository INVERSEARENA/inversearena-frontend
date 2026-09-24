import { test, mock, afterEach, beforeEach } from "node:test";
import assert from "node:assert";
import { AuthService } from "../src/services/authService";
import { RefreshTokenModel } from "../src/db/models/refreshToken.model";
import { SessionStore } from "../src/cache/sessionStore";

process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";

/**
 * In-memory replacement for the Redis-backed SessionStore, matching the
 * shape used in auth.unit.test.ts so per-device revocation tests can assert
 * exactly which JTIs were removed without a live Redis.
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

beforeEach(() => {
  sessions = new FakeSessionStore();
  authService = new AuthService(sessions);
});

afterEach(() => {
  mock.reset();
});

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    _id: "row-id",
    familyId: "family-a",
    userId: "user-1",
    used: false,
    revoked: false,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    accessJti: "access-a",
    refreshJti: "refresh-a",
    deviceLabel: "Chrome on macOS",
    ip: "1.2.3.4",
    ...overrides,
  };
}

test("listSessions: returns only active (unused, unrevoked, unexpired) rows", async () => {
  const rows = [makeRow()];
  mock.method(RefreshTokenModel, "find", () => ({
    sort: () => Promise.resolve(rows),
  }));

  const result = await authService.listSessions("user-1");

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0]!.familyId, "family-a");
  assert.strictEqual(result[0]!.deviceLabel, "Chrome on macOS");
  assert.strictEqual(result[0]!.ip, "1.2.3.4");
});

test("listSessions: flags the caller's own current session", async () => {
  const rows = [makeRow({ familyId: "family-a", accessJti: "access-a" }), makeRow({ familyId: "family-b", accessJti: "access-b" })];
  mock.method(RefreshTokenModel, "find", () => ({
    sort: () => Promise.resolve(rows),
  }));

  const result = await authService.listSessions("user-1", "access-b");

  const a = result.find((s) => s.familyId === "family-a")!;
  const b = result.find((s) => s.familyId === "family-b")!;
  assert.strictEqual(a.current, false);
  assert.strictEqual(b.current, true);
});

test("listSessions: falls back to 'Unknown device' for rows predating device tracking", async () => {
  const rows = [makeRow({ deviceLabel: undefined, ip: undefined })];
  mock.method(RefreshTokenModel, "find", () => ({
    sort: () => Promise.resolve(rows),
  }));

  const result = await authService.listSessions("user-1");

  assert.strictEqual(result[0]!.deviceLabel, "Unknown device");
  assert.strictEqual(result[0]!.ip, null);
});

test("revokeSession: 404s when the session does not exist or belongs to another user", async () => {
  mock.method(RefreshTokenModel, "findOne", async () => null);

  await assert.rejects(
    () => authService.revokeSession("user-1", "someone-elses-family"),
    (err: unknown) => (err as { status: number }).status === 404,
  );
});

test("revokeSession: revoking one session does not touch another active session's JTIs", async () => {
  // Two devices for the same user, each with its own family + JTI pair.
  await sessions.addSession("wallet-1", "access-a", 900);
  await sessions.addSession("wallet-1", "refresh-a", 604800);
  await sessions.addSession("wallet-1", "access-b", 900);
  await sessions.addSession("wallet-1", "refresh-b", 604800);

  const rowA = makeRow({ familyId: "family-a", accessJti: "access-a", refreshJti: "refresh-a" });
  mock.method(RefreshTokenModel, "findOne", async () => rowA);
  const updateMany = mock.method(RefreshTokenModel, "updateMany", async () => ({}));

  await authService.revokeSession("user-1", "family-a");

  // Family A's own DB rows are marked revoked.
  assert.strictEqual(updateMany.mock.callCount(), 1);
  assert.deepStrictEqual(updateMany.mock.calls[0]!.arguments[0], { familyId: "family-a" });

  // Family A's JTIs are gone from Redis...
  assert.strictEqual(await sessions.isActive("access-a"), false);
  assert.strictEqual(await sessions.isActive("refresh-a"), false);
  // ...but family B's (the other device) are untouched.
  assert.strictEqual(await sessions.isActive("access-b"), true);
  assert.strictEqual(await sessions.isActive("refresh-b"), true);
});

test("revokeSession: tolerates a row missing accessJti/refreshJti (pre-#1410 rows)", async () => {
  const legacyRow = makeRow({ accessJti: undefined, refreshJti: undefined });
  mock.method(RefreshTokenModel, "findOne", async () => legacyRow);
  mock.method(RefreshTokenModel, "updateMany", async () => ({}));

  // Must not throw even though there is no JTI to remove from Redis.
  await authService.revokeSession("user-1", "family-a");
});
