/**
 * Shared wallet-balance cache (#1625).
 *
 * The header, the join modal and the stake modal all need the connected
 * wallet's XLM/USDC balance. Before this cache each of them issued its own
 * Horizon request for the same account, and none of them refreshed after a
 * confirmed transaction — so the UI kept showing the pre-transaction amount
 * until something unrelated happened to re-render.
 *
 * This module owns three things:
 *
 *  - a per (network, wallet, asset) value cache with a freshness window;
 *  - request de-duplication: at most one in-flight Horizon read per
 *    (network, wallet, asset), shared by every concurrent caller;
 *  - an invalidation channel the transaction flow controller pokes when a
 *    transaction confirms, so every consumer refreshes from one place.
 *
 * Two invariants matter more than the caching itself:
 *
 *  - **Failures are never cached.** A Horizon outage must keep raising
 *    `StellarBalanceError` (#1295) rather than latching a stale-but-plausible
 *    zero into the cache, where it would look like an authoritative answer
 *    for the rest of the freshness window.
 *  - **The network is part of the key.** Testnet and mainnet point at
 *    different Horizon servers and can hold the same public key with
 *    different balances, so a cached testnet balance must never be served
 *    on mainnet.
 */
import { isStellarConfigured, stellarConfig } from "@/shared/config/stellarConfig";
import { fetchAssetBalance, type Balance } from "./stellar-balance";

export type BalanceAssetCode = "XLM" | "USDC";

/**
 * How long a cached balance is served without revalidating.
 *
 * Balances only change when the connected wallet moves funds, and every such
 * movement goes through a transaction the app submits itself — which
 * invalidates the cache explicitly. The window therefore only has to cover
 * "the same page asked twice", not "the user moved money elsewhere".
 */
export const BALANCE_CACHE_STALE_MS = 15_000;

const KEY_SEPARATOR = "|";

export interface BalanceCacheEntry {
  /** The cached amount. */
  readonly value: number;
  /** When the value was fetched, in epoch milliseconds. */
  readonly fetchedAt: number;
}

/**
 * Why a subscriber is being notified.
 *
 * `updated` means a value was written to the cache (a read completed, or a
 * background revalidation landed); `invalidated` means a value was dropped
 * and the next read will hit the network again.
 */
export interface BalanceCacheEvent {
  /** The wallet whose balances changed. */
  publicKey: string;
  /** The asset that changed, or undefined for a wallet-wide invalidation. */
  assetCode: BalanceAssetCode | undefined;
  reason: "updated" | "invalidated";
}

export type BalanceCacheListener = (event: BalanceCacheEvent) => void;

export interface BalanceCacheOptions {
  /** Injectable clock, so tests can age entries without sleeping. */
  now?: () => number;
  /** How long a cached value counts as fresh. */
  staleMs?: number;
}

/**
 * The network the cached balances belong to.
 *
 * Read defensively: `stellarConfig` throws lazily when the app is not
 * configured for Stellar (#1134), and the balance cache must never be the
 * reason a page explodes.
 */
function currentNetworkScope(): string {
  if (!isStellarConfigured) return "unconfigured";
  try {
    const name: unknown = stellarConfig.networkName;
    if (typeof name === "string" && name.length > 0) return name;
    const horizon: unknown = stellarConfig.horizonUrl;
    if (typeof horizon === "string" && horizon.length > 0) return horizon;
    return "unconfigured";
  } catch {
    return "unconfigured";
  }
}

/**
 * A per-(wallet, asset) balance cache with request de-duplication,
 * stale-while-revalidate reads and explicit invalidation.
 */
export class BalanceCache {
  private readonly entries = new Map<string, BalanceCacheEntry>();
  private readonly inflight = new Map<string, Promise<number>>();
  private readonly listeners = new Set<BalanceCacheListener>();
  private readonly now: () => number;
  private readonly staleMs: number;
  private revision = 0;

  constructor(options: BalanceCacheOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.staleMs = options.staleMs ?? BALANCE_CACHE_STALE_MS;
  }

  /**
   * Monotonic counter bumped on every write and every invalidation. Lets a
   * React consumer subscribe with `useSyncExternalStore` without needing to
   * diff the cached values itself.
   */
  getVersion(): number {
    return this.revision;
  }

  private key(publicKey: string, assetCode: BalanceAssetCode): string {
    return `${currentNetworkScope()}${KEY_SEPARATOR}${publicKey}${KEY_SEPARATOR}${assetCode}`;
  }

  /** The cached value, but only while it is still fresh. */
  get(publicKey: string, assetCode: BalanceAssetCode): BalanceCacheEntry | undefined {
    const entry = this.entries.get(this.key(publicKey, assetCode));
    if (!entry) return undefined;
    return this.now() - entry.fetchedAt <= this.staleMs ? entry : undefined;
  }

  /**
   * The cached value regardless of age — the stale-while-revalidate
   * fallback. Never used on its own to decide what to show; it exists so a
   * stale read can serve the last known amount while a refresh runs.
   */
  getStale(publicKey: string, assetCode: BalanceAssetCode): BalanceCacheEntry | undefined {
    return this.entries.get(this.key(publicKey, assetCode));
  }

  /** Store a freshly fetched value and notify subscribers. */
  set(publicKey: string, assetCode: BalanceAssetCode, value: number): void {
    this.entries.set(this.key(publicKey, assetCode), { value, fetchedAt: this.now() });
    this.revision += 1;
    this.emit({ publicKey, assetCode, reason: "updated" });
  }

  /**
   * Drop one asset, or every asset, for a wallet.
   *
   * Called by the transaction flow controller once a transaction confirms:
   * the wallet's balance has provably changed on-chain, so the cached copy
   * is wrong and must not be served again.
   */
  invalidate(publicKey: string, assetCode?: BalanceAssetCode): void {
    const suffix = assetCode
      ? `${KEY_SEPARATOR}${publicKey}${KEY_SEPARATOR}${assetCode}`
      : `${KEY_SEPARATOR}${publicKey}`;

    let changed = false;
    for (const key of Array.from(this.entries.keys())) {
      if (key.endsWith(suffix)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (!changed) return;

    this.revision += 1;
    this.emit({ publicKey, assetCode, reason: "invalidated" });
  }

  /** Drop every cached balance, for every wallet and asset. */
  invalidateAll(): void {
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.revision += 1;
    this.emit({ publicKey: "*", assetCode: undefined, reason: "invalidated" });
  }

  /** Subscribe to cache writes and invalidations. Returns an unsubscribe function. */
  subscribe(listener: BalanceCacheListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Run `loader` at most once per (wallet, asset) at a time.
   *
   * Concurrent callers share the same promise, so N components asking for the
   * same balance produce exactly one Horizon request. The value is written to
   * the cache only on success — a rejected loader leaves the cache untouched.
   */
  load(
    publicKey: string,
    assetCode: BalanceAssetCode,
    loader: () => Promise<number>,
  ): Promise<number> {
    const key = this.key(publicKey, assetCode);
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const pending = loader()
      .then((value) => {
        this.set(publicKey, assetCode, value);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, pending);
    return pending;
  }

  /**
   * Read a balance through the cache.
   *
   *  - a fresh entry is served as-is;
   *  - a stale entry is served immediately and revalidated in the background
   *    (stale-while-revalidate), so the UI never waits on the network for a
   *    number it already knows;
   *  - with no entry at all, the caller waits for the shared in-flight read.
   */
  async read(
    publicKey: string,
    assetCode: BalanceAssetCode,
    loader: () => Promise<number>,
  ): Promise<number> {
    const fresh = this.get(publicKey, assetCode);
    if (fresh) return fresh.value;

    const stale = this.getStale(publicKey, assetCode);
    if (stale) {
      void this.load(publicKey, assetCode, loader).catch(() => {
        // A failed background revalidation keeps the last known value in
        // place; the failure is surfaced by the next explicit read.
      });
      return stale.value;
    }

    return this.load(publicKey, assetCode, loader);
  }

  private emit(event: BalanceCacheEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch {
        // A misbehaving subscriber must never break a cache write.
      }
    }
  }
}

/**
 * The app-wide balance cache. A single instance is deliberate: the point of
 * the cache is that the header, the join modal and the stake modal share
 * one read, not three.
 */
export const balanceCache = new BalanceCache();

/**
 * Reset the shared cache. Exposed for tests, which need each case to start
 * from a known-empty cache instead of inheriting the previous case's values.
 */
export function resetBalanceCache(): void {
  balanceCache.invalidateAll();
}

/**
 * Drop every cached balance for a wallet.
 *
 * This is the invalidation hook the transaction flow controller calls once a
 * transaction confirms: the wallet's balance has changed on-chain, so the
 * cached copy must not be served again.
 */
export function invalidateWalletBalances(publicKey: string): void {
  balanceCache.invalidate(publicKey);
}

export interface WalletBalanceOptions {
  /**
   * Ignore the freshness window and re-read from the network.
   *
   * Used by explicit user-triggered refreshes, which must always hit
   * Horizon. Ordinary reads go through the cache and may be served from it.
   */
  force?: boolean;
}

/**
 * Read a wallet's XLM and USDC balances through the shared cache.
 *
 * Both assets are read independently but share the cache's request
 * de-duplication, so a wallet that has never been read costs exactly two
 * Horizon requests — one per asset — no matter how many components ask.
 */
export async function getWalletBalance(
  publicKey: string,
  options: WalletBalanceOptions = {},
): Promise<Balance> {
  const force = options.force ?? false;

  const readOne = (assetCode: BalanceAssetCode): Promise<number> =>
    force
      ? balanceCache.load(publicKey, assetCode, () => fetchAssetBalance(publicKey, assetCode))
      : balanceCache.read(publicKey, assetCode, () => fetchAssetBalance(publicKey, assetCode));

  const [xlm, usdc] = await Promise.all([readOne("XLM"), readOne("USDC")]);
  return { xlm, usdc };
}
