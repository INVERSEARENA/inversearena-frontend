import type { SessionState, SessionStatus, SessionTokens } from "./types";

/**
 * Single source of truth for the backend wallet session.
 *
 * Hooks must use `getAuthHeaders()` / `useSession()` rather than reading
 * `access_token` directly: the store owns token rotation, expiry bookkeeping,
 * and cross-tab synchronisation (see #1714).
 */
export const ACCESS_TOKEN_KEY = "access_token";
export const REFRESH_TOKEN_KEY = "refresh_token";
export const SESSION_WALLET_KEY = "inversearena:session:walletAddress";
export const SESSION_EXPIRES_KEY = "inversearena:session:expiresAt";
export const REFRESH_LOCK_KEY = "inversearena:session:refresh-lock";
export const SESSION_CHANNEL = "inversearena:session";

const REFRESH_SKEW_MS = 60_000;
const LOCK_TTL_MS = 15_000;

const INITIAL_STATE: SessionState = {
  status: "unauthenticated",
  walletAddress: null,
  expiresAt: 0,
  error: null,
};

type Listener = (state: SessionState) => void;
const listeners = new Set<Listener>();

let state: SessionState = { ...INITIAL_STATE };
let hydrated = false;
let channel: BroadcastChannel | null = null;

function storage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

/** Decodes the `exp` claim of a JWT without verifying its signature. */
export function decodeTokenExpiry(token: string): number {
  try {
    const segment = token.split(".")[1];
    if (!segment) return 0;
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(normalized)) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function readState(): SessionState {
  const store = storage();
  if (!store) return { ...INITIAL_STATE };

  const accessToken = store.getItem(ACCESS_TOKEN_KEY);
  const refreshToken = store.getItem(REFRESH_TOKEN_KEY);
  if (!accessToken || !refreshToken) return { ...INITIAL_STATE };

  const walletAddress = store.getItem(SESSION_WALLET_KEY);
  const storedExpiry = Number(store.getItem(SESSION_EXPIRES_KEY) ?? 0);
  const expiresAt = Number.isFinite(storedExpiry) && storedExpiry > 0
    ? storedExpiry
    : decodeTokenExpiry(accessToken);

  return {
    status: "authenticated",
    walletAddress,
    expiresAt,
    error: null,
  };
}

/** Hydrates once from storage; later reads use the in-memory snapshot. */
export function getSessionState(): SessionState {
  if (!hydrated) {
    state = readState();
    hydrated = true;
    installCrossTabSync();
  }
  return state;
}

export function subscribeSession(listener: Listener): () => void {
  getSessionState();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(next: SessionState): void {
  state = next;
  listeners.forEach((listener) => listener(state));
}

export function setSessionStatus(status: SessionStatus, error: string | null = null): void {
  getSessionState();
  emit({ ...state, status, error: status === "error" ? error : null });
}

function broadcast(type: "tokens" | "cleared", tokens?: SessionTokens, walletAddress?: string | null): void {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
  if (!channel) channel = new BroadcastChannel(SESSION_CHANNEL);
  channel.postMessage({ type, tokens, walletAddress });
}

/** Persists a fresh token pair and broadcasts it to sibling tabs. */
export function setSession(tokens: SessionTokens, walletAddress: string | null = null): void {
  getSessionState();
  const expiresAt = decodeTokenExpiry(tokens.accessToken);
  const store = storage();
  if (store) {
    store.setItem(ACCESS_TOKEN_KEY, tokens.accessToken);
    store.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
    if (walletAddress) store.setItem(SESSION_WALLET_KEY, walletAddress);
    store.setItem(SESSION_EXPIRES_KEY, String(expiresAt));
  }
  emit({
    status: "authenticated",
    walletAddress: walletAddress ?? state.walletAddress,
    expiresAt,
    error: null,
  });
  broadcast("tokens", tokens, walletAddress);
}

/** Clears the local session (and tells other tabs to do the same). */
export function clearSession(): void {
  getSessionState();
  const store = storage();
  if (store) {
    store.removeItem(ACCESS_TOKEN_KEY);
    store.removeItem(REFRESH_TOKEN_KEY);
    store.removeItem(SESSION_WALLET_KEY);
    store.removeItem(SESSION_EXPIRES_KEY);
  }
  emit({ ...INITIAL_STATE });
  broadcast("cleared");
}

export function getSessionTokens(): SessionTokens | null {
  const store = storage();
  if (!store) return null;
  const accessToken = store.getItem(ACCESS_TOKEN_KEY);
  const refreshToken = store.getItem(REFRESH_TOKEN_KEY);
  return accessToken && refreshToken ? { accessToken, refreshToken } : null;
}

export function isAccessTokenExpiringSoon(now = Date.now()): boolean {
  const { expiresAt } = getSessionState();
  // Tokens without a decodable `exp` are legacy values: send them as-is and
  // let the backend reject them rather than forcing a refresh on every call.
  return expiresAt > 0 && expiresAt - now <= REFRESH_SKEW_MS;
}

/** Cross-tab single-flight: only one tab may call /auth/refresh at a time. */
export function acquireRefreshLock(owner: string): boolean {
  const store = storage();
  if (!store) return true;
  const current = store.getItem(REFRESH_LOCK_KEY);
  if (current) {
    try {
      const heldAt = JSON.parse(current) as { owner: string; at: number };
      if (Date.now() - heldAt.at < LOCK_TTL_MS && heldAt.owner !== owner) return false;
    } catch {
      // Malformed lock — treat it as stale and take ownership.
    }
  }
  store.setItem(REFRESH_LOCK_KEY, JSON.stringify({ owner, at: Date.now() }));
  return true;
}

export function releaseRefreshLock(owner: string): void {
  const store = storage();
  if (!store) return;
  try {
    const current = JSON.parse(store.getItem(REFRESH_LOCK_KEY) ?? "null") as { owner: string } | null;
    if (current?.owner === owner) store.removeItem(REFRESH_LOCK_KEY);
  } catch {
    store.removeItem(REFRESH_LOCK_KEY);
  }
}

export async function waitForRefreshLock(timeoutMs = 10_000): Promise<boolean> {
  const store = storage();
  if (!store) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = store.getItem(REFRESH_LOCK_KEY);
    if (!current) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function installCrossTabSync(): void {
  if (typeof window === "undefined") return;

  window.addEventListener("storage", (event) => {
    if (
      event.key === ACCESS_TOKEN_KEY ||
      event.key === REFRESH_TOKEN_KEY ||
      event.key === SESSION_WALLET_KEY ||
      event.key === SESSION_EXPIRES_KEY ||
      event.key === null
    ) {
      state = readState();
      listeners.forEach((listener) => listener(state));
    }
  });

  if (typeof BroadcastChannel !== "undefined") {
    if (!channel) channel = new BroadcastChannel(SESSION_CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      const message = event.data as {
        type?: string;
        tokens?: SessionTokens;
        walletAddress?: string | null;
      };
      if (message?.type === "cleared") {
        state = { ...INITIAL_STATE };
      } else if (message?.type === "tokens" && message.tokens) {
        state = readState();
      }
      listeners.forEach((listener) => listener(state));
    };
  }
}

/** Test helper: resets module state without touching other tabs' storage. */
export function resetSessionStoreForTests(): void {
  state = { ...INITIAL_STATE };
  hydrated = false;
  channel?.close();
  channel = null;
}
