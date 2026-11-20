import { signChallenge } from "../challenge";
import {
  getAuthHeaders,
  loginWithWallet,
  logoutSession,
  refreshSession,
  stopRefreshTimer,
} from "../sessionClient";
import {
  ACCESS_TOKEN_KEY,
  clearSession,
  getSessionState,
  REFRESH_TOKEN_KEY,
  resetSessionStoreForTests,
  setSession,
} from "../sessionStore";

jest.mock("../challenge", () => ({
  signChallenge: jest.fn(),
  CHALLENGE_DATA_KEY: "inversearena_auth_challenge",
}));

const WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const mockedSignChallenge = signChallenge as jest.MockedFunction<typeof signChallenge>;

function jwt(expiresAtSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expiresAtSeconds })).toString("base64url");
  return `${header}.${payload}.signature`;
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

const signer = {
  walletAddress: WALLET,
  signMessage: jest.fn(async () => "c2lnbmF0dXJl"),
  signTransaction: jest.fn(async () => "signed-xdr"),
};

describe("wallet session client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    window.localStorage.clear();
    resetSessionStoreForTests();
    global.fetch = jest.fn() as jest.Mock;
  });

  afterEach(() => {
    stopRefreshTimer();
    clearSession();
    jest.useRealTimers();
  });

  it("uses the backend challenge, verifies the signature and stores the session", async () => {
    const accessToken = jwt(Math.floor(Date.now() / 1000) + 900);
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ nonce: "backend-challenge", expiresAt: "2026-01-01T00:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ accessToken, refreshToken: "refresh-1", user: { id: "1" } }));
    mockedSignChallenge.mockResolvedValue({ signature: "c2lnbmF0dXJl" });

    await loginWithWallet(signer, "Test SDF Network ; September 2015");

    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain("/api/auth/nonce");
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toEqual({ walletAddress: WALLET });
    expect(mockedSignChallenge).toHaveBeenCalledWith(
      "backend-challenge",
      signer,
      "Test SDF Network ; September 2015",
    );
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body)).toEqual({
      walletAddress: WALLET,
      signature: "c2lnbmF0dXJl",
    });
    expect(window.localStorage.getItem(ACCESS_TOKEN_KEY)).toBe(accessToken);
    expect(window.localStorage.getItem(REFRESH_TOKEN_KEY)).toBe("refresh-1");
    expect(getSessionState().walletAddress).toBe(WALLET);
    expect(getSessionState().status).toBe("authenticated");
  });

  it("forwards a signed challenge transaction for wallets without message signing", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ nonce: "backend-challenge" }))
      .mockResolvedValueOnce(jsonResponse({ accessToken: jwt(Math.floor(Date.now() / 1000) + 900), refreshToken: "r" }));
    mockedSignChallenge.mockResolvedValue({ signedChallengeXdr: "signed-xdr" });

    await loginWithWallet({ walletAddress: WALLET, signTransaction: signer.signTransaction }, "passphrase");

    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body)).toEqual({
      walletAddress: WALLET,
      signedChallengeXdr: "signed-xdr",
    });
  });

  it("clears the session when login fails", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({ nonce: "challenge" }));
    mockedSignChallenge.mockRejectedValue(new Error("User rejected"));

    await expect(loginWithWallet(signer, "passphrase")).rejects.toThrow("User rejected");
    expect(getSessionState().status).toBe("error");
    expect(window.localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
  });

  it("refreshes silently once when concurrent callers see an expiring token", async () => {
    const now = Math.floor(Date.now() / 1000);
    setSession({ accessToken: jwt(now + 30), refreshToken: "old-refresh" }, WALLET);
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({ accessToken: jwt(now + 900), refreshToken: "new-refresh" }),
    );

    const pending = Promise.all([getAuthHeaders(), getAuthHeaders()]);
    // The losing tab waits on the cross-tab lock using short timers.
    await jest.advanceTimersByTimeAsync(500);
    const [first, second] = await pending;

    const refreshCalls = (global.fetch as jest.Mock).mock.calls.filter((call) =>
      String(call[0]).includes("/api/auth/refresh"),
    );
    expect(refreshCalls).toHaveLength(1);
    expect(JSON.parse(refreshCalls[0][1].body)).toEqual({ refreshToken: "old-refresh" });
    expect(first).toEqual({ Authorization: `Bearer ${jwt(now + 900)}` });
    expect(second).toEqual(first);
  });

  it("does not refresh a token that is still fresh", async () => {
    setSession({ accessToken: jwt(Math.floor(Date.now() / 1000) + 900), refreshToken: "r" }, WALLET);

    const headers = await getAuthHeaders();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(headers).toEqual({ Authorization: expect.stringContaining("Bearer ") });
  });

  it("clears and revokes the session on logout", async () => {
    setSession({ accessToken: jwt(Math.floor(Date.now() / 1000) + 900), refreshToken: "r" }, WALLET);
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ message: "Logged out" }));

    await logoutSession();

    const logoutCalls = (global.fetch as jest.Mock).mock.calls.filter((call) =>
      String(call[0]).includes("/api/auth/logout"),
    );
    expect(logoutCalls).toHaveLength(1);
    expect(logoutCalls[0][1].headers.Authorization).toContain("Bearer ");
    expect(window.localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(getSessionState().status).toBe("unauthenticated");
  });

  it("surfaces the backend error message from a nested API error envelope", async () => {
    setSession({ accessToken: jwt(Math.floor(Date.now() / 1000) + 10), refreshToken: "r" }, WALLET);
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({ error: { code: "REFRESH_EXPIRED", message: "session expired" } }, false),
    );

    await expect(refreshSession()).rejects.toThrow("session expired");
    expect(getSessionState().status).toBe("error");
  });

  it("makes a failed refresh clear local tokens", async () => {
    setSession({ accessToken: jwt(Math.floor(Date.now() / 1000) + 10), refreshToken: "r" }, WALLET);
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ error: "expired" }, false));

    await expect(refreshSession()).rejects.toThrow("expired");
    expect(window.localStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
    expect(getSessionState().status).toBe("error");
  });
});
