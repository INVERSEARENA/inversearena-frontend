import {
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  REFRESH_LOCK_KEY,
  SESSION_EXPIRES_KEY,
  SESSION_WALLET_KEY,
  acquireRefreshLock,
  clearSession,
  decodeTokenExpiry,
  getSessionState,
  getSessionTokens,
  isAccessTokenExpiringSoon,
  releaseRefreshLock,
  resetSessionStoreForTests,
  setSession,
  setSessionStatus,
  subscribeSession,
  waitForRefreshLock,
} from "../sessionStore";
import type { SessionState } from "../types";

const WALLET = "GABCDEF1234567890";

function token(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.signature`;
}

function futureToken(offsetSeconds = 3600): string {
  return token(Math.floor(Date.now() / 1000) + offsetSeconds);
}

function sessionState(): SessionState {
  return getSessionState();
}

describe("wallet session store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.restoreAllMocks();
    resetSessionStoreForTests();
  });

  it("decodes the exp claim without verifying the signature", () => {
    expect(decodeTokenExpiry(token(1_700_000_000))).toBe(1_700_000_000_000);
    expect(decodeTokenExpiry("not-a-jwt")).toBe(0);
    expect(decodeTokenExpiry("header..signature")).toBe(0);
  });

  it("persists tokens, wallet address and expiry, then notifies subscribers", () => {
    const listener = jest.fn();
    const unsubscribe = subscribeSession(listener);
    const accessToken = futureToken();
    const refreshToken = "refresh-token";

    setSession({ accessToken, refreshToken }, WALLET);

    expect(window.localStorage.getItem(ACCESS_TOKEN_KEY)).toBe(accessToken);
    expect(window.localStorage.getItem(REFRESH_TOKEN_KEY)).toBe(refreshToken);
    expect(window.localStorage.getItem(SESSION_WALLET_KEY)).toBe(WALLET);
    expect(sessionState()).toMatchObject({
      status: "authenticated",
      walletAddress: WALLET,
      expiresAt: decodeTokenExpiry(accessToken),
      error: null,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getSessionTokens()).toEqual({ accessToken, refreshToken });

    unsubscribe();
    setSessionStatus("error", "failed");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("hydrates a session from storage once", () => {
    const accessToken = futureToken();
    window.localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    window.localStorage.setItem(REFRESH_TOKEN_KEY, "refresh-token");
    window.localStorage.setItem(SESSION_WALLET_KEY, WALLET);
    window.localStorage.setItem(SESSION_EXPIRES_KEY, "1234567890000");

    expect(sessionState()).toMatchObject({
      status: "authenticated",
      walletAddress: WALLET,
      expiresAt: 1234567890000,
    });

    window.localStorage.setItem(SESSION_WALLET_KEY, "OTHER");
    expect(sessionState().walletAddress).toBe(WALLET);
  });

  it("is unauthenticated when either token is missing", () => {
    window.localStorage.setItem(ACCESS_TOKEN_KEY, futureToken());
    expect(sessionState()).toMatchObject({ status: "unauthenticated", walletAddress: null });
    expect(getSessionTokens()).toBeNull();
  });

  it("clears tokens and resets state across storage events", () => {
    const listener = jest.fn();
    subscribeSession(listener);
    setSession({ accessToken: futureToken(), refreshToken: "refresh-token" }, WALLET);

    clearSession();

    expect(sessionState()).toMatchObject({
      status: "unauthenticated",
      walletAddress: null,
      expiresAt: 0,
      error: null,
    });
    expect(window.localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(window.localStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
    expect(window.localStorage.getItem(SESSION_WALLET_KEY)).toBeNull();
    expect(window.localStorage.getItem(SESSION_EXPIRES_KEY)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    setSession({ accessToken: futureToken(), refreshToken: "refresh-token" }, WALLET);
    window.localStorage.removeItem(ACCESS_TOKEN_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: ACCESS_TOKEN_KEY }));
    expect(sessionState().status).toBe("unauthenticated");
  });

  it("tracks expiring access tokens and leaves legacy opaque tokens alone", () => {
    setSession({ accessToken: token(Math.floor(Date.now() / 1000) - 10), refreshToken: "r" }, WALLET);
    expect(isAccessTokenExpiringSoon()).toBe(true);

    setSession({ accessToken: futureToken(3600), refreshToken: "r" }, WALLET);
    expect(isAccessTokenExpiringSoon()).toBe(false);

    // Tokens without a decodable `exp` are legacy values; hooks still send
    // them so existing sessions keep working until the backend rejects them.
    setSession({ accessToken: "opaque-token", refreshToken: "r" }, WALLET);
    expect(isAccessTokenExpiringSoon()).toBe(false);
  });

  it("uses a single-flight refresh lock that expires", async () => {
    expect(acquireRefreshLock("tab-a")).toBe(true);
    expect(acquireRefreshLock("tab-b")).toBe(false);
    expect(acquireRefreshLock("tab-a")).toBe(true);

    releaseRefreshLock("tab-a");
    expect(window.localStorage.getItem(REFRESH_LOCK_KEY)).toBeNull();
    expect(acquireRefreshLock("tab-b")).toBe(true);

    window.localStorage.setItem(
      REFRESH_LOCK_KEY,
      JSON.stringify({ owner: "tab-a", at: Date.now() - 60_000 }),
    );
    expect(acquireRefreshLock("tab-b")).toBe(true);
    releaseRefreshLock("tab-b");
  });

  it("waits for a held refresh lock to be released", async () => {
    expect(acquireRefreshLock("tab-a")).toBe(true);

    const waited = waitForRefreshLock(500);
    releaseRefreshLock("tab-a");

    await expect(waited).resolves.toBe(true);
  });

  it("reports status transitions without persisting them", () => {
    setSessionStatus("authenticating");
    expect(sessionState()).toMatchObject({ status: "authenticating", error: null });

    setSessionStatus("error", "network mismatch");
    expect(sessionState()).toMatchObject({ status: "error", error: "network mismatch" });

    setSessionStatus("authenticated");
    expect(sessionState()).toMatchObject({ status: "authenticated", error: null });
  });
});
