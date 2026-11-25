import type { SessionState, SessionStatus, SessionTokens } from "./types";
import { localStorageManager as storageManager, StorageKey } from "../localStorage";

/**
 * Single source of truth for the backend wallet session.
 *
 * Hooks must use `getAuthHeaders()` / `useSession()` rather than reading
 * `access_token` directly: the store owns token rotation, expiry bookkeeping,
 * and cross-tab synchronisation (see #1714).
 */
export const ACCESS_TOKEN_KEY = StorageKey.ACCESS_TOKEN;
export const REFRESH_TOKEN_KEY = StorageKey.REFRESH_TOKEN;
export const SESSION_WALLET_KEY = StorageKey.SESSION_WALLET;
export const SESSION_EXPIRES_KEY = StorageKey.SESSION_EXPIRES;
export const REFRESH_LOCK_KEY = StorageKey.SESSION_REFRESH_LOCK;
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
  const accessToken = storageManager.getString(ACCESS_TOKEN_KEY);
  const refreshToken = storageManager.getString(REFRESH_TOKEN_KEY);
  if (!accessToken || !refreshToken) return { ...INITIAL_STATE };

  const walletAddress = storageManager.getString(SESSION_WALLET_KEY);
  const storedExpiry = Number(storageManager.getString(SESSION_EXPIRES_KEY) ?? 0);
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
  storageManager.setString(ACCESS_TOKEN_KEY, tokens.accessToken);
  storageManager.setString(REFRESH_TOKEN_KEY, tokens.refreshToken);
  if (walletAddress) storageManager.setString(SESSION_WALLET_KEY, walletAddress);
  storageManager.setString(SESSION_EXPIRES_KEY, String(expiresAt));
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
  storageManager.removeItem(ACCESS_TOKEN_KEY);
  storageManager.removeItem(REFRESH_TOKEN_KEY);
  storageManager.removeItem(SESSION_WALLET_KEY);
  storageManager.removeItem(SESSION_EXPIRES_KEY);
  emit({ ...INITIAL_STATE });
  broadcast("cleared");
}

export function getSessionTokens(): SessionTokens | null {
  const accessToken = storageManager.getString(ACCESS_TOKEN_KEY);
  const refreshToken = storageManager.getString(REFRESH_TOKEN_KEY);
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
  const current = storageManager.getItem<{ owner: string; at: number } | null>(REFRESH_LOCK_KEY, null);
  if (current) {
    if (Date.now() - current.at < LOCK_TTL_MS && current.owner !== owner) return false;
  }
  storageManager.setItem(REFRESH_LOCK_KEY, { owner, at: Date.now() });
  return true;
}

export function releaseRefreshLock(owner: string): void {
  try {
    const current = storageManager.getItem<{ owner: string } | null>(REFRESH_LOCK_KEY, null);
    if (current?.owner === owner) storageManager.removeItem(REFRESH_LOCK_KEY);
  } catch {
    storageManager.removeItem(REFRESH_LOCK_KEY);
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
