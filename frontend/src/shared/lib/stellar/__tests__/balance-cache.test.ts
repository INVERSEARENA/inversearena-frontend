/**
 * Tests for the shared wallet-balance cache (#1625).
 *
 * The cache has to satisfy three properties at once:
 *  - concurrent readers of the same (wallet, asset) share a single request;
 *  - a stale value is served immediately and refreshed in the background;
 *  - an invalidated value is never served again, and a failed lookup is
 *    never remembered as a value.
 */
import { BalanceCache } from "@/shared/lib/stellar/balance-cache";

const PUBLIC_KEY = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const OTHER_KEY = "GCKFBEIYTKP5RDBQMUFJUMOOR2A46QMWDS4M7A6NZK2WQOG3ZHPJDPD3";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("BalanceCache", () => {
  it("collapses concurrent reads of the same wallet+asset into one request", async () => {
    const cache = new BalanceCache();
    const loader = jest.fn().mockResolvedValue(42);

    const results = await Promise.all([
      cache.load(PUBLIC_KEY, "XLM", loader),
      cache.load(PUBLIC_KEY, "XLM", loader),
      cache.load(PUBLIC_KEY, "XLM", loader),
    ]);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(results).toEqual([42, 42, 42]);
  });

  it("keeps different assets and different wallets on separate requests", async () => {
    const cache = new BalanceCache();
    const loader = jest.fn().mockResolvedValue(1);

    await Promise.all([
      cache.load(PUBLIC_KEY, "XLM", loader),
      cache.load(PUBLIC_KEY, "USDC", loader),
      cache.load(OTHER_KEY, "XLM", loader),
    ]);

    expect(loader).toHaveBeenCalledTimes(3);
  });

  it("serves a fresh cached value without calling the loader again", async () => {
    const cache = new BalanceCache();
    const loader = jest.fn().mockResolvedValue(7);

    await cache.load(PUBLIC_KEY, "XLM", loader);
    const second = await cache.read(PUBLIC_KEY, "XLM", loader);

    expect(second).toBe(7);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("serves a stale value immediately and revalidates it in the background", async () => {
    let now = 1_000;
    const cache = new BalanceCache({ now: () => now, staleMs: 100 });
    const loader = jest.fn().mockResolvedValueOnce(7).mockResolvedValueOnce(9);

    await cache.load(PUBLIC_KEY, "XLM", loader);

    // Age the entry past the freshness window.
    now = 2_000;

    const stale = await cache.read(PUBLIC_KEY, "XLM", loader);
    expect(stale).toBe(7);

    // The refresh happens in the background — give it a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loader).toHaveBeenCalledTimes(2);
    expect(cache.get(PUBLIC_KEY, "XLM")?.value).toBe(9);
  });

  it("drops the cached value on invalidation so the next read refetches", async () => {
    const cache = new BalanceCache();
    const loader = jest.fn().mockResolvedValueOnce(7).mockResolvedValueOnce(11);

    await cache.load(PUBLIC_KEY, "XLM", loader);
    expect(cache.get(PUBLIC_KEY, "XLM")?.value).toBe(7);

    cache.invalidate(PUBLIC_KEY);

    expect(cache.get(PUBLIC_KEY, "XLM")).toBeUndefined();
    expect(cache.getStale(PUBLIC_KEY, "XLM")).toBeUndefined();

    const refreshed = await cache.read(PUBLIC_KEY, "XLM", loader);
    expect(refreshed).toBe(11);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("invalidates only the requested asset when one is named", async () => {
    const cache = new BalanceCache();

    await cache.load(PUBLIC_KEY, "XLM", async () => 1);
    await cache.load(PUBLIC_KEY, "USDC", async () => 2);

    cache.invalidate(PUBLIC_KEY, "XLM");

    expect(cache.get(PUBLIC_KEY, "XLM")).toBeUndefined();
    expect(cache.get(PUBLIC_KEY, "USDC")?.value).toBe(2);
  });

  it("leaves other wallets untouched when one wallet is invalidated", async () => {
    const cache = new BalanceCache();

    await cache.load(PUBLIC_KEY, "XLM", async () => 1);
    await cache.load(OTHER_KEY, "XLM", async () => 2);

    cache.invalidate(PUBLIC_KEY);

    expect(cache.get(PUBLIC_KEY, "XLM")).toBeUndefined();
    expect(cache.get(OTHER_KEY, "XLM")?.value).toBe(2);
  });

  it("never caches a failed lookup", async () => {
    const cache = new BalanceCache();
    const loader = jest.fn().mockRejectedValue(new Error("Horizon is down"));

    await expect(cache.load(PUBLIC_KEY, "XLM", loader)).rejects.toThrow("Horizon is down");

    expect(cache.get(PUBLIC_KEY, "XLM")).toBeUndefined();
    expect(cache.getStale(PUBLIC_KEY, "XLM")).toBeUndefined();
  });

  it("keeps the last known value when a background revalidation fails", async () => {
    let now = 1_000;
    const cache = new BalanceCache({ now: () => now, staleMs: 100 });
    const loader = jest
      .fn()
      .mockResolvedValueOnce(7)
      .mockRejectedValueOnce(new Error("Horizon is down"));

    await cache.load(PUBLIC_KEY, "XLM", loader);
    now = 2_000;

    const stale = await cache.read(PUBLIC_KEY, "XLM", loader);
    expect(stale).toBe(7);

    await new Promise((resolve) => setTimeout(resolve, 0));

    // The failed refresh must not evict the value we already know.
    expect(cache.getStale(PUBLIC_KEY, "XLM")?.value).toBe(7);
  });

  it("notifies subscribers when a value is written and when it is invalidated", async () => {
    const cache = new BalanceCache();
    const events: string[] = [];
    const unsubscribe = cache.subscribe((event) => {
      events.push(`${event.reason}:${event.publicKey}:${event.assetCode ?? "*"}`);
    });

    await cache.load(PUBLIC_KEY, "XLM", async () => 3);
    cache.invalidate(PUBLIC_KEY);

    expect(events).toEqual(["updated:" + PUBLIC_KEY + ":XLM", "invalidated:" + PUBLIC_KEY + ":*"]);

    unsubscribe();
    await cache.load(PUBLIC_KEY, "XLM", async () => 4);
    expect(events).toHaveLength(2);
  });

  it("does not let a throwing subscriber break a cache write", async () => {
    const cache = new BalanceCache();
    cache.subscribe(() => {
      throw new Error("subscriber exploded");
    });

    await expect(cache.load(PUBLIC_KEY, "XLM", async () => 5)).resolves.toBe(5);
    expect(cache.get(PUBLIC_KEY, "XLM")?.value).toBe(5);
  });

  it("bumps its version on writes and invalidations", async () => {
    const cache = new BalanceCache();
    const before = cache.getVersion();

    await cache.load(PUBLIC_KEY, "XLM", async () => 1);
    const afterWrite = cache.getVersion();
    expect(afterWrite).toBeGreaterThan(before);

    cache.invalidate(PUBLIC_KEY);
    expect(cache.getVersion()).toBeGreaterThan(afterWrite);
  });

  it("shares a single in-flight request between a stale read and a forced reload", async () => {
    const cache = new BalanceCache();
    const pending = deferred<number>();
    const loader = jest.fn().mockReturnValue(pending.promise);

    const first = cache.load(PUBLIC_KEY, "XLM", loader);
    const second = cache.load(PUBLIC_KEY, "XLM", loader);

    expect(loader).toHaveBeenCalledTimes(1);

    pending.resolve(13);
    await expect(first).resolves.toBe(13);
    await expect(second).resolves.toBe(13);
  });
});
