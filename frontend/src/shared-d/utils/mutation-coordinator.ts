/**
 * Cross-tab wallet mutation coordinator (#1492).
 *
 * When Inverse Arena is open in multiple browser tabs under the same wallet,
 * each tab runs its own copy of the transaction pipeline. Without
 * coordination, two tabs can race to build, sign, and submit the same
 * join / commit / reveal / claim operation — producing duplicate wallet
 * prompts, conflicting commit salts, and on-chain duplicates that waste gas
 * or fail with an idempotency error.
 *
 * This module provides a typed coordinator that:
 *   1. Serialises mutations by key (network · wallet · arena · round · action).
 *   2. Elects exactly one "owner" tab via `BroadcastChannel`; falls back to
 *      `storage` events when `BroadcastChannel` is unavailable (e.g. some
 *      private-browsing contexts).
 *   3. Keeps ownership alive with a heartbeat and automatically reclaims it
 *      when the owning tab crashes or closes.
 *   4. Propagates terminal outcomes (confirmed / rejected / expired / unknown)
 *      to all tabs so non-owner tabs can trigger authoritative reconciliation.
 *   5. Prevents two tabs from generating different salts for the same
 *      wallet · arena · round commitment.
 *
 * ## Usage
 *
 * ```ts
 * const coordinator = getMutationCoordinator();
 *
 * const lock = await coordinator.acquire(key);
 * if (!lock.owned) {
 *   // Another tab is already handling this mutation.
 *   // `coordinator.subscribe(key, handler)` will deliver the outcome.
 *   return;
 * }
 * try {
 *   // build / sign / submit
 *   coordinator.setOutcome(key, { status: "confirmed", txHash: "…" });
 * } catch (err) {
 *   coordinator.setOutcome(key, { status: "rejected", reason: String(err) });
 * } finally {
 *   coordinator.release(key);
 * }
 * ```
 *
 * See `frontend/docs/MUTATION_COORDINATOR.md` for the full lock-key schema
 * and state-transition diagram.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** The four mutation actions that can race across tabs. */
export type MutationAction = "join" | "commit" | "reveal" | "claim";

/**
 * Canonical string key that identifies one unique mutation.
 * Construct with {@link buildMutationKey}.
 */
export type MutationKey = string & { readonly __brand: "MutationKey" };

/**
 * Possible terminal outcomes propagated to all tabs once an operation
 * completes (or times out).
 */
export type MutationOutcome =
  | { status: "confirmed"; txHash: string }
  | { status: "rejected"; reason: string }
  | { status: "expired" }
  | { status: "unknown" };

/**
 * What `acquire()` returns.
 * `owned === true`  → this tab holds the lock; it must call `release()`.
 * `owned === false` → another tab already owns the lock for this key.
 */
export type AcquireResult =
  | { owned: true }
  | { owned: false; pendingOwner: string };

/** Internal lock record stored in `localStorage`. */
interface LockRecord {
  /** Opaque identifier for the tab that owns this lock. */
  ownerId: string;
  /** Millisecond timestamp of the last heartbeat from the owner. */
  heartbeatAt: number;
  /** Millisecond timestamp when this lock was acquired. */
  acquiredAt: number;
}

/** Message envelope sent over BroadcastChannel / localStorage events. */
type CoordinatorMessage =
  | { type: "heartbeat"; key: MutationKey; ownerId: string }
  | { type: "acquire"; key: MutationKey; ownerId: string }
  | { type: "release"; key: MutationKey; ownerId: string }
  | { type: "outcome"; key: MutationKey; outcome: MutationOutcome };

// ─── Constants ────────────────────────────────────────────────────────────────

/** Milliseconds between heartbeat pulses from the owning tab. */
export const HEARTBEAT_INTERVAL_MS = 1_500;

/**
 * A lock whose last heartbeat is older than this value is considered stale
 * and may be reclaimed by another tab.  Four heartbeat intervals gives the
 * owning tab time to recover from a brief background throttle without losing
 * the lock unnecessarily.
 */
export const LOCK_EXPIRY_MS = HEARTBEAT_INTERVAL_MS * 4; // 6 000 ms

/**
 * Maximum age of an outcome record kept in localStorage.  Entries older than
 * this are ignored so stale data from a previous session doesn't interfere.
 */
const OUTCOME_TTL_MS = 30_000;

/** localStorage key-space prefix — all coordinator entries start with this. */
const LS_LOCK_PREFIX = "inversearena:coordinator:lock:";
const LS_OUTCOME_PREFIX = "inversearena:coordinator:outcome:";
const LS_BC_FALLBACK_PREFIX = "inversearena:coordinator:msg:";

/** BroadcastChannel name shared across all tabs on the same origin. */
const CHANNEL_NAME = "inversearena:mutation-coordinator";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate an opaque, tab-unique identifier.  Uses `crypto.randomUUID` when
 * available (all modern browsers), with a manual fallback that is good enough
 * for a tab-ID: collisions across concurrent tabs are astronomically unlikely.
 */
function generateTabId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback: timestamp + random hex segment
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Construct a canonical {@link MutationKey} from its components.
 *
 * @param network     - Stellar network passphrase (or short alias, e.g. "testnet").
 * @param walletKey   - Stellar public key of the acting wallet.
 * @param arenaId     - On-chain arena contract address.
 * @param round       - Round number (0-based integer).
 * @param action      - One of "join" | "commit" | "reveal" | "claim".
 */
export function buildMutationKey(
  network: string,
  walletKey: string,
  arenaId: string,
  round: number,
  action: MutationAction,
): MutationKey {
  return `${network}:${walletKey}:${arenaId}:${round}:${action}` as MutationKey;
}

/** Safe `localStorage.getItem` that returns `null` when storage is unavailable. */
function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Safe `localStorage.setItem`. */
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage full or unavailable — best-effort */
  }
}

/** Safe `localStorage.removeItem`. */
function lsRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* noop */
  }
}

// ─── Coordinator ──────────────────────────────────────────────────────────────

/** Callback type for outcome subscribers. */
export type OutcomeHandler = (outcome: MutationOutcome) => void;

/** Callback type for pending-state subscribers (non-owner tabs). */
export type PendingHandler = (ownerId: string) => void;

/**
 * The coordinator instance returned by {@link getMutationCoordinator} /
 * {@link createMutationCoordinator}.
 */
export interface MutationCoordinator {
  /**
   * Attempt to acquire the exclusive lock for `key`.
   *
   * - If no live lock exists (or the existing one is stale), this tab becomes
   *   the owner and the lock record is written.
   * - If a live lock held by another tab exists, returns `owned: false`.
   *
   * The caller *must* eventually call {@link release} when ownership is no
   * longer needed, regardless of success or failure.
   */
  acquire(key: MutationKey): AcquireResult;

  /**
   * Release the lock held by this tab for `key`.  A no-op if this tab does
   * not own the lock.  Called automatically by {@link setOutcome}.
   */
  release(key: MutationKey): void;

  /**
   * Broadcast a terminal outcome for `key` to all tabs and write it to
   * `localStorage` for tabs that come online later.  Also releases the lock.
   */
  setOutcome(key: MutationKey, outcome: MutationOutcome): void;

  /**
   * Register a handler that will be called when a terminal outcome is
   * received for `key`, regardless of which tab produced it.  Returns a
   * cleanup function.
   */
  subscribe(key: MutationKey, handler: OutcomeHandler): () => void;

  /**
   * Register a handler that will be called when this tab observes that
   * another tab has acquired `key` (and is thus showing a pending state).
   * Useful for mirroring "pending" UI in non-owner tabs.  Returns a cleanup.
   */
  onPending(key: MutationKey, handler: PendingHandler): () => void;

  /**
   * Read the most recent outcome stored in `localStorage` for `key`, if any.
   * Returns `null` when no outcome has been recorded or the record has
   * expired (> {@link OUTCOME_TTL_MS}).
   */
  getStoredOutcome(key: MutationKey): MutationOutcome | null;

  /**
   * True if this tab currently owns the lock for `key`.
   */
  isOwner(key: MutationKey): boolean;

  /**
   * Tear down the coordinator: stop all heartbeats, remove event listeners,
   * close the BroadcastChannel.  After calling this the instance must not be
   * used.  Primarily for tests and cleanup on wallet/network change.
   */
  destroy(): void;
}

interface OwnedLock {
  heartbeatTimer: ReturnType<typeof setInterval>;
}

interface OutcomeEntry {
  outcome: MutationOutcome;
  recordedAt: number;
}

/**
 * Create a new, isolated coordinator instance.  In production code, use the
 * module-level singleton {@link getMutationCoordinator} instead.
 *
 * Exposed separately so tests can create fresh instances per test case.
 */
export function createMutationCoordinator(): MutationCoordinator {
  const tabId = generateTabId();

  // BroadcastChannel (primary transport) — may be null in private browsing
  // contexts that don't expose BroadcastChannel.
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch {
    channel = null;
  }

  // Tracks locks this tab owns.
  const ownedLocks = new Map<MutationKey, OwnedLock>();

  // Outcome listeners keyed by MutationKey.
  const outcomeListeners = new Map<MutationKey, Set<OutcomeHandler>>();

  // Pending listeners keyed by MutationKey.
  const pendingListeners = new Map<MutationKey, Set<PendingHandler>>();

  // ── Internal: broadcast a message ──────────────────────────────────────────

  function broadcast(msg: CoordinatorMessage): void {
    // BroadcastChannel path
    if (channel) {
      try {
        channel.postMessage(msg);
        return;
      } catch {
        /* channel may have been closed; fall through to storage fallback */
      }
    }
    // localStorage event fallback — write a timestamped entry so other tabs
    // pick it up via the `storage` event (which fires for all tabs *except*
    // the one that wrote).
    const fallbackKey = `${LS_BC_FALLBACK_PREFIX}${Date.now()}-${Math.random().toString(16).slice(2)}`;
    lsSet(fallbackKey, JSON.stringify({ ...msg, _t: Date.now() }));
    // Remove the entry shortly after so it doesn't accumulate.
    setTimeout(() => lsRemove(fallbackKey), 5_000);
  }

  // ── Internal: dispatch a received message ──────────────────────────────────

  function handleMessage(msg: CoordinatorMessage): void {
    if (msg.type === "acquire") {
      // Another tab just acquired a key — notify pending listeners.
      const listeners = pendingListeners.get(msg.key);
      if (listeners) {
        for (const fn of listeners) fn(msg.ownerId);
      }
    } else if (msg.type === "outcome") {
      // Persist the outcome locally so late-arriving tabs can read it.
      lsSet(
        `${LS_OUTCOME_PREFIX}${msg.key}`,
        JSON.stringify({ outcome: msg.outcome, recordedAt: Date.now() } satisfies OutcomeEntry),
      );
      // Notify outcome subscribers.
      const listeners = outcomeListeners.get(msg.key);
      if (listeners) {
        for (const fn of listeners) fn(msg.outcome);
      }
    }
    // "heartbeat" and "release" are informational — no listener dispatch needed
    // beyond what the lock-staleness check already does.
  }

  // ── Wire up BroadcastChannel listener ──────────────────────────────────────

  if (channel) {
    channel.onmessage = (event: MessageEvent<CoordinatorMessage>) => {
      handleMessage(event.data);
    };
  }

  // ── Wire up localStorage storage-event fallback ────────────────────────────

  function handleStorageEvent(event: StorageEvent): void {
    if (!event.key) return;
    if (event.key.startsWith(LS_BC_FALLBACK_PREFIX) && event.newValue) {
      try {
        const msg = JSON.parse(event.newValue) as CoordinatorMessage & { _t?: number };
        // Ignore our own writes — the storage event doesn't fire in the
        // originating tab, but if we somehow receive it, skip it.
        if ("ownerId" in msg && msg.ownerId === tabId) return;
        handleMessage(msg);
      } catch {
        /* malformed entry — ignore */
      }
    } else if (event.key.startsWith(LS_OUTCOME_PREFIX) && event.newValue) {
      // A tab wrote an outcome record directly (e.g. via setOutcome + lsSet).
      // Re-dispatch it through our listener system for any subscribers in this tab.
      try {
        const entry = JSON.parse(event.newValue) as OutcomeEntry;
        const key = event.key.slice(LS_OUTCOME_PREFIX.length) as MutationKey;
        const listeners = outcomeListeners.get(key);
        if (listeners) {
          for (const fn of listeners) fn(entry.outcome);
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleStorageEvent);
  }

  // ── Lock helpers ───────────────────────────────────────────────────────────

  function readLock(key: MutationKey): LockRecord | null {
    const raw = lsGet(`${LS_LOCK_PREFIX}${key}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as LockRecord;
    } catch {
      return null;
    }
  }

  function writeLock(key: MutationKey, record: LockRecord): void {
    lsSet(`${LS_LOCK_PREFIX}${key}`, JSON.stringify(record));
  }

  function deleteLock(key: MutationKey): void {
    lsRemove(`${LS_LOCK_PREFIX}${key}`);
  }

  function isLockStale(record: LockRecord): boolean {
    return Date.now() - record.heartbeatAt > LOCK_EXPIRY_MS;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  function acquire(key: MutationKey): AcquireResult {
    const existing = readLock(key);

    if (existing && !isLockStale(existing) && existing.ownerId !== tabId) {
      // A live lock is held by another tab.
      return { owned: false, pendingOwner: existing.ownerId };
    }

    // Either no lock, a stale lock, or we already own it — take ownership.
    const now = Date.now();
    const record: LockRecord = { ownerId: tabId, heartbeatAt: now, acquiredAt: now };
    writeLock(key, record);

    // Start heartbeat.
    if (!ownedLocks.has(key)) {
      const timer = setInterval(() => {
        const current = readLock(key);
        // Stop the heartbeat if our lock was evicted (e.g. by a stale-reclaim
        // in another tab — should be extremely rare but possible under heavy
        // throttling).
        if (!current || current.ownerId !== tabId) {
          clearInterval(timer);
          ownedLocks.delete(key);
          return;
        }
        writeLock(key, { ...current, heartbeatAt: Date.now() });
        broadcast({ type: "heartbeat", key, ownerId: tabId });
      }, HEARTBEAT_INTERVAL_MS);
      ownedLocks.set(key, { heartbeatTimer: timer });
    }

    broadcast({ type: "acquire", key, ownerId: tabId });
    return { owned: true };
  }

  function release(key: MutationKey): void {
    const lock = ownedLocks.get(key);
    if (!lock) return; // This tab doesn't own the key.

    clearInterval(lock.heartbeatTimer);
    ownedLocks.delete(key);
    deleteLock(key);
    broadcast({ type: "release", key, ownerId: tabId });
  }

  function setOutcome(key: MutationKey, outcome: MutationOutcome): void {
    // Write to localStorage first so late tabs can read it synchronously.
    lsSet(
      `${LS_OUTCOME_PREFIX}${key}`,
      JSON.stringify({ outcome, recordedAt: Date.now() } satisfies OutcomeEntry),
    );
    // Notify local subscribers in this tab.
    const local = outcomeListeners.get(key);
    if (local) {
      for (const fn of local) fn(outcome);
    }
    // Propagate to all other tabs.
    broadcast({ type: "outcome", key, outcome });
    // Release the lock (also stops the heartbeat).
    release(key);
  }

  function subscribe(key: MutationKey, handler: OutcomeHandler): () => void {
    if (!outcomeListeners.has(key)) {
      outcomeListeners.set(key, new Set());
    }
    outcomeListeners.get(key)!.add(handler);

    // Immediately deliver a stored outcome if one exists (e.g. this tab came
    // online after the owning tab already finished).
    const stored = getStoredOutcome(key);
    if (stored) {
      // Defer one microtask so the caller's cleanup reference is set up first.
      Promise.resolve().then(() => handler(stored)).catch(() => {});
    }

    return () => {
      outcomeListeners.get(key)?.delete(handler);
    };
  }

  function onPending(key: MutationKey, handler: PendingHandler): () => void {
    if (!pendingListeners.has(key)) {
      pendingListeners.set(key, new Set());
    }
    pendingListeners.get(key)!.add(handler);
    return () => {
      pendingListeners.get(key)?.delete(handler);
    };
  }

  function getStoredOutcome(key: MutationKey): MutationOutcome | null {
    const raw = lsGet(`${LS_OUTCOME_PREFIX}${key}`);
    if (!raw) return null;
    try {
      const entry = JSON.parse(raw) as OutcomeEntry;
      if (Date.now() - entry.recordedAt > OUTCOME_TTL_MS) return null;
      return entry.outcome;
    } catch {
      return null;
    }
  }

  function isOwner(key: MutationKey): boolean {
    return ownedLocks.has(key);
  }

  function destroy(): void {
    // Stop all heartbeats.
    for (const [key, lock] of ownedLocks) {
      clearInterval(lock.heartbeatTimer);
      deleteLock(key);
    }
    ownedLocks.clear();
    outcomeListeners.clear();
    pendingListeners.clear();

    if (channel) {
      try {
        channel.close();
      } catch {
        /* ignore */
      }
      channel = null;
    }

    if (typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorageEvent);
    }
  }

  return { acquire, release, setOutcome, subscribe, onPending, getStoredOutcome, isOwner, destroy };
}

// ─── Module-level singleton ────────────────────────────────────────────────

let _singleton: MutationCoordinator | null = null;

/**
 * Return the module-level singleton coordinator.  Created lazily on first
 * call so SSR environments (where `BroadcastChannel` and `localStorage` are
 * absent) never instantiate it during server-side rendering.
 *
 * Tests should use {@link createMutationCoordinator} directly to get isolated
 * instances.
 */
export function getMutationCoordinator(): MutationCoordinator {
  if (!_singleton) {
    _singleton = createMutationCoordinator();
  }
  return _singleton;
}

/**
 * Replace the module-level singleton with the provided instance.  Exposed
 * for testing only.
 *
 * @internal
 */
export function _setMutationCoordinatorForTest(instance: MutationCoordinator | null): void {
  _singleton = instance;
}
