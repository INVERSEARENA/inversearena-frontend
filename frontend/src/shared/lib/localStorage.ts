/** Versioned, SSR-safe access to browser persistence. Keep direct Web Storage
 * access inside this module so failures in private browsing/quota-limited
 * contexts never escape into feature code. */
export enum StorageKey {
  ARENA_SETTINGS = "arena_settings",
  ONBOARDING_COMPLETED = "onboarding_completed",
  HAS_STAKED = "inversearena_has_staked",
  ARENA_POOL_DRAFT = "arena_pool_draft",
  ACCESS_TOKEN = "access_token",
  REFRESH_TOKEN = "refresh_token",
  SESSION_WALLET = "inversearena:session:walletAddress",
  SESSION_EXPIRES = "inversearena:session:expiresAt",
  SESSION_REFRESH_LOCK = "inversearena:session:refresh-lock",
  PASSKEY = "inversearena_passkey",
  WALLET_DISCONNECTED = "inversearena:wallet:disconnected",
  QUICK_PLAY_PREFS = "inversearena:quick-play",
  ONBOARDING_TOUR = "inverse.arena.onboarding-complete",
  LEGACY_ONBOARDING_TOUR = "inverse.arena-v2.onboarding-complete",
  PENDING_DEPOSIT = "sep24_pending_deposit",
  WITHDRAWAL_TOKEN = "inversearena:withdrawal:token",
  TRANSACTION_INTENT_PREFIX = "inversearena:transaction-intent",
  MUTATION_COORDINATOR_PREFIX = "inversearena:mutation",
}

export type StorageScope = "user" | "device";
interface Entry<T> { version: number; scope: StorageScope; validate(value: unknown): value is T; }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const entries: Record<string, Entry<unknown>> = {
  [StorageKey.ARENA_SETTINGS]: { version: 1, scope: "device", validate: isRecord },
  [StorageKey.ONBOARDING_COMPLETED]: { version: 1, scope: "user", validate: isBoolean },
  [StorageKey.HAS_STAKED]: { version: 1, scope: "user", validate: isBoolean },
  [StorageKey.ARENA_POOL_DRAFT]: { version: 1, scope: "user", validate: isRecord },
  [StorageKey.ACCESS_TOKEN]: { version: 1, scope: "user", validate: isString },
  [StorageKey.REFRESH_TOKEN]: { version: 1, scope: "user", validate: isString },
  [StorageKey.SESSION_WALLET]: { version: 1, scope: "user", validate: isString },
  [StorageKey.SESSION_EXPIRES]: { version: 1, scope: "user", validate: isString },
  [StorageKey.SESSION_REFRESH_LOCK]: { version: 1, scope: "device", validate: isRecord },
  [StorageKey.PASSKEY]: { version: 1, scope: "user", validate: isRecord },
  [StorageKey.WALLET_DISCONNECTED]: { version: 1, scope: "device", validate: isBoolean },
  [StorageKey.QUICK_PLAY_PREFS]: { version: 1, scope: "device", validate: isRecord },
  [StorageKey.ONBOARDING_TOUR]: { version: 1, scope: "user", validate: isBoolean },
  [StorageKey.LEGACY_ONBOARDING_TOUR]: { version: 1, scope: "user", validate: isBoolean },
  [StorageKey.PENDING_DEPOSIT]: { version: 1, scope: "user", validate: isRecord },
  [StorageKey.WITHDRAWAL_TOKEN]: { version: 1, scope: "device", validate: isString },
};

/** Register namespaced per-arena/per-round keys with the same schema rules. */
export function registerStorageKey<T>(key: string, scope: StorageScope, validate: (value: unknown) => value is T): string {
  if (!key || key.length > 512) throw new Error("Invalid browser storage key");
  entries[key] = { version: 1, scope, validate };
  return key;
}

function browserStore(): Storage | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; } catch { return null; }
}
function browserSessionStore(): Storage | null {
  if (typeof window === "undefined") return null;
  try { return window.sessionStorage; } catch { return null; }
}
function envelope<T>(key: string, value: T): string {
  const entry = entries[key];
  if (!entry) throw new Error(`Unregistered browser storage key: ${key}`);
  return JSON.stringify({ __iaStorage: true, version: entry.version, value });
}

function read<T>(key: string, fallback: T, storeProvider: () => Storage | null = browserStore): T {
  const store = storeProvider();
  if (!store) return fallback;
  try {
    const raw = store.getItem(key);
    if (raw === null) return fallback;
    const entry = entries[key];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { parsed = entry?.validate(raw) ? raw : undefined; }
    if (isRecord(parsed) && parsed.__iaStorage === true) {
      if (!entry || parsed.version !== entry.version) return fallback;
      parsed = parsed.value;
    } else if (entry && !entry.validate(parsed) && entry.validate(raw)) {
      // Older versions stored bare strings (tokens, leases, and tab locks).
      parsed = raw;
    }
    if (parsed === undefined) return fallback;
    if (entry && !entry.validate(parsed)) return fallback;
    return parsed as T;
  } catch { return fallback; }
}

function write<T>(key: string, value: T, storeProvider: () => Storage | null = browserStore): boolean {
  const store = storeProvider();
  if (!store) return false;
  try {
    const entry = entries[key];
    if (!entry || !entry.validate(value)) return false;
    store.setItem(key, envelope(key, value));
    return true;
  } catch { return false; }
}

export const localStorageManager = {
  getItem: <T>(key: string, fallback: T): T => read(key, fallback),
  setItem: <T>(key: string, value: T): boolean => write(key, value),
  removeItem: (key: string): void => { try { browserStore()?.removeItem(key); } catch { /* unavailable */ } },
  getString: (key: string): string | null => read<string | null>(key, null),
  setString: (key: string, value: string): boolean => write(key, value),
  clearUserScopedState: (): void => {
    const store = browserStore();
    if (!store) return;
    try {
      for (const key of Object.keys(store)) if (entries[key]?.scope === "user") store.removeItem(key);
    } catch { /* unavailable */ }
  },
  clearArenaStorage: (): void => {
    const store = browserStore();
    if (!store) return;
    try { Object.keys(store).filter((key) => key.startsWith("arena_")).forEach((key) => store.removeItem(key)); }
    catch { /* unavailable */ }
  },
};

/** Session-scoped counterpart, using the same versioned schemas and guards. */
export const sessionStorageManager = {
  getItem: <T>(key: string, fallback: T): T => read(key, fallback, browserSessionStore),
  setItem: <T>(key: string, value: T): boolean => write(key, value, browserSessionStore),
  getString: (key: string): string | null => read<string | null>(key, null, browserSessionStore),
  setString: (key: string, value: string): boolean => write(key, value, browserSessionStore),
  removeItem: (key: string): void => { try { browserSessionStore()?.removeItem(key); } catch { /* unavailable */ } },
};
