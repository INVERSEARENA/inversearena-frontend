import { signChallenge } from "./challenge";
import {
  acquireRefreshLock,
  clearSession,
  decodeTokenExpiry,
  getSessionState,
  getSessionTokens,
  isAccessTokenExpiringSoon,
  releaseRefreshLock,
  setSession,
  setSessionStatus,
  waitForRefreshLock,
} from "./sessionStore";
import type { AuthChallenge, ChallengeSigner, LoginProof, SessionTokens } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
const REFRESH_SKEW_MS = 60_000;
const TAB_ID = typeof crypto !== "undefined" && "randomUUID" in crypto
  ? crypto.randomUUID()
  : Math.random().toString(36).slice(2);

let refreshInFlight: Promise<SessionTokens> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

async function postJson<T>(path: string, body: unknown, accessToken?: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as {
      error?: string | { code?: string; message?: string };
      message?: string;
    };
    // Backend errors use { error: { code, message } }; older endpoints may
    // still return { error: "..." } or { message: "..." }.
    const message =
      typeof payload.error === "string"
        ? payload.error
        : payload.error?.message ?? payload.message ?? `Request failed (${response.status})`;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function requestChallenge(walletAddress: string): Promise<AuthChallenge> {
  return postJson<AuthChallenge>("/api/auth/nonce", { walletAddress });
}

export async function verifyChallenge(
  walletAddress: string,
  proof: LoginProof,
): Promise<SessionTokens> {
  const result = await postJson<SessionTokens & { user?: unknown }>("/api/auth/verify", {
    walletAddress,
    ...proof,
  });
  return { accessToken: result.accessToken, refreshToken: result.refreshToken };
}

/**
 * Requests a backend challenge, signs it with the connected wallet, and stores
 * the resulting session. A failed login never leaves a stale token behind.
 */
export async function loginWithWallet(signer: ChallengeSigner, networkPassphrase: string): Promise<void> {
  setSessionStatus("authenticating");
  try {
    const challenge = await requestChallenge(signer.walletAddress);
    const proof = await signChallenge(challenge.nonce, signer, networkPassphrase);
    const tokens = await verifyChallenge(signer.walletAddress, proof);
    setSession(tokens, signer.walletAddress);
    scheduleRefresh();
  } catch (error) {
    clearSession();
    setSessionStatus("error", error instanceof Error ? error.message : "Unable to sign in");
    throw error;
  }
}

async function performRefresh(): Promise<SessionTokens> {
  const tokens = getSessionTokens();
  if (!tokens) throw new Error("No session to refresh");
  const refreshed = await postJson<SessionTokens>("/api/auth/refresh", {
    refreshToken: tokens.refreshToken,
  });
  setSession(refreshed, getSessionState().walletAddress);
  return refreshed;
}

/**
 * Rotates the session before the access token expires. A module-level promise
 * makes concurrent callers share one request, and a short localStorage lock
 * extends that single-flight guarantee across tabs.
 */
export async function refreshSession(): Promise<SessionTokens> {
  if (refreshInFlight) return refreshInFlight;

  const ownsLock = acquireRefreshLock(TAB_ID);
  if (!ownsLock) {
    const released = await waitForRefreshLock();
    const tokens = getSessionTokens();
    const expiry = tokens ? decodeTokenExpiry(tokens.accessToken) : 0;
    if (released && tokens && expiry > 0 && expiry - Date.now() > REFRESH_SKEW_MS) return tokens;
    // The other tab never completed its refresh — take over the lock.
    if (!acquireRefreshLock(TAB_ID)) throw new Error("Session refresh is already in progress");
  }

  refreshInFlight = performRefresh()
    .then((tokens) => {
      scheduleRefresh();
      return tokens;
    })
    .catch((error) => {
      clearSession();
      setSessionStatus("error", error instanceof Error ? error.message : "Session expired");
      throw error;
    })
    .finally(() => {
      releaseRefreshLock(TAB_ID);
      refreshInFlight = null;
    });

  return refreshInFlight;
}

/** Proactively schedules the next silent refresh from the token's expiry. */
export function scheduleRefresh(): void {
  if (typeof window === "undefined") return;
  if (refreshTimer) clearTimeout(refreshTimer);
  const { status, expiresAt } = getSessionState();
  if (status !== "authenticated" || !expiresAt) return;
  const delay = Math.max(0, expiresAt - Date.now() - REFRESH_SKEW_MS);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshSession().catch(() => {
      // Error state is set by refreshSession(); no need to double-report.
    });
  }, delay);
}

export function stopRefreshTimer(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
}

/** Revokes the backend session and clears all local token state. */
export async function logoutSession(): Promise<void> {
  stopRefreshTimer();
  const tokens = getSessionTokens();
  clearSession();
  if (!tokens) return;
  try {
    await postJson("/api/auth/logout", {}, tokens.accessToken);
  } catch {
    // Local sign-out must succeed even if the backend/Redis is unreachable.
  }
}

/** Best-effort revoke used when the connected wallet changes or disconnects. */
export function revokeSessionForWalletChange(): void {
  if (!getSessionTokens()) return;
  void logoutSession();
}

/**
 * Async auth-header provider for every authenticated frontend hook. The
 * session store hydrates legacy tokens once, then owns rotation from there.
 */
export async function getAuthHeaders(): Promise<HeadersInit> {
  const tokens = getSessionTokens();
  if (!tokens || typeof window === "undefined") return {};

  if (isAccessTokenExpiringSoon()) {
    try {
      await refreshSession();
    } catch {
      return {};
    }
  }

  const current = getSessionTokens();
  return current ? { Authorization: `Bearer ${current.accessToken}` } : {};
}
