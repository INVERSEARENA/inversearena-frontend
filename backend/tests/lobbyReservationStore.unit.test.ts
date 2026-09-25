/**
 * Unit coverage for backend-authoritative lobby capacity reservations
 * (#1406): atomic reserve-or-reject via a single Redis Lua script, release,
 * and active-count/TTL bookkeeping.
 */
import { LobbyReservationStore } from "../src/cache/lobbyReservationStore";

/**
 * A minimal in-process reimplementation of RESERVE_SLOT_SCRIPT's semantics,
 * standing in for `redis.eval` so these tests exercise real reserve/expire
 * logic (not just "was eval called with some arguments"). Each entry maps
 * userId -> expiresAt (ms), mirroring the Redis sorted set the real script
 * operates on.
 */
class FakeRedis {
  private sets = new Map<string, Map<string, number>>();

  private set(key: string): Map<string, number> {
    let s = this.sets.get(key);
    if (!s) {
      s = new Map();
      this.sets.set(key, s);
    }
    return s;
  }

  async eval(
    _script: string,
    _numKeys: number,
    key: string,
    userId: string,
    nowArg: string,
    expiresAtArg: string,
    remainingCapacityArg: string,
  ): Promise<number> {
    const now = Number(nowArg);
    const expiresAt = Number(expiresAtArg);
    const remainingCapacity = Number(remainingCapacityArg);
    const s = this.set(key);

    for (const [member, score] of [...s.entries()]) {
      if (score <= now) s.delete(member);
    }

    if (s.has(userId)) {
      s.set(userId, expiresAt);
      return 1;
    }

    if (s.size >= remainingCapacity) {
      return 0;
    }

    s.set(userId, expiresAt);
    return 1;
  }

  async zrem(key: string, userId: string): Promise<number> {
    const s = this.set(key);
    const had = s.delete(userId);
    return had ? 1 : 0;
  }

  async zremrangebyscore(key: string, _min: string, max: number): Promise<number> {
    const s = this.set(key);
    let removed = 0;
    for (const [member, score] of [...s.entries()]) {
      if (score <= max) {
        s.delete(member);
        removed++;
      }
    }
    return removed;
  }

  async zcard(key: string): Promise<number> {
    return this.set(key).size;
  }

  async zscore(key: string, userId: string): Promise<string | null> {
    const score = this.set(key).get(userId);
    return score === undefined ? null : String(score);
  }
}

function makeStore() {
  const fakeRedis = new FakeRedis();
  // LobbyReservationStore's constructor type is `Redis` (ioredis), but at
  // runtime it only ever calls the five methods FakeRedis implements above.
  const store = new LobbyReservationStore(fakeRedis as never);
  return { store, fakeRedis };
}

describe("LobbyReservationStore.reserveSlot", () => {
  it("reserves a slot when capacity remains", async () => {
    const { store } = makeStore();

    const result = await store.reserveSlot("arena-1", "user-a", 2, 120);

    expect(result.reserved).toBe(true);
    expect(result.expiresAt).not.toBeNull();
  });

  it("rejects reservation when the arena is already full", async () => {
    const { store } = makeStore();

    await store.reserveSlot("arena-1", "user-a", 1, 120);
    const second = await store.reserveSlot("arena-1", "user-b", 1, 120);

    expect(second.reserved).toBe(false);
    expect(second.expiresAt).toBeNull();
  });

  it("only one of two simultaneous callers wins the last slot", async () => {
    const { store } = makeStore();
    await store.reserveSlot("arena-1", "user-a", 2, 120);
    // One slot remains (capacity 2, one already held by user-a).

    const [first, second] = await Promise.all([
      store.reserveSlot("arena-1", "user-b", 2, 120),
      store.reserveSlot("arena-1", "user-c", 2, 120),
    ]);

    const reservedCount = [first, second].filter((r) => r.reserved).length;
    expect(reservedCount).toBe(1);
  });

  it("refreshes an existing reservation's TTL instead of double-counting", async () => {
    const { store } = makeStore();

    await store.reserveSlot("arena-1", "user-a", 1, 120);
    const again = await store.reserveSlot("arena-1", "user-a", 1, 120);

    expect(again.reserved).toBe(true);
    const count = await store.activeReservationCount("arena-1");
    expect(count).toBe(1);
  });

  it("returns reserved:false without calling eval when remainingCapacity is zero", async () => {
    const { store, fakeRedis } = makeStore();
    const evalSpy = jest.spyOn(fakeRedis, "eval");

    const result = await store.reserveSlot("arena-1", "user-a", 0, 120);

    expect(result.reserved).toBe(false);
    expect(evalSpy).not.toHaveBeenCalled();
  });

  it("frees a slot for a new reservation once the holder's TTL has elapsed", async () => {
    const { store } = makeStore();
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;

    try {
      await store.reserveSlot("arena-1", "user-a", 1, 1); // ttl = 1s
      now += 2_000; // advance past expiry

      const result = await store.reserveSlot("arena-1", "user-b", 1, 1);
      expect(result.reserved).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("LobbyReservationStore.releaseSlot", () => {
  it("frees the released slot for another reservation", async () => {
    const { store } = makeStore();
    await store.reserveSlot("arena-1", "user-a", 1, 120);

    await store.releaseSlot("arena-1", "user-a");

    const result = await store.reserveSlot("arena-1", "user-b", 1, 120);
    expect(result.reserved).toBe(true);
  });

  it("is a no-op when the user holds no reservation", async () => {
    const { store } = makeStore();
    await expect(store.releaseSlot("arena-1", "nobody")).resolves.not.toThrow();
  });
});

describe("LobbyReservationStore.activeReservationCount", () => {
  it("excludes expired reservations from the count", async () => {
    const { store } = makeStore();
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;

    try {
      await store.reserveSlot("arena-1", "user-a", 5, 1);
      await store.reserveSlot("arena-1", "user-b", 5, 120);
      now += 2_000;

      const count = await store.activeReservationCount("arena-1");
      expect(count).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("LobbyReservationStore.hasReservation", () => {
  it("is true for an active reservation and false after it expires", async () => {
    const { store } = makeStore();
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;

    try {
      await store.reserveSlot("arena-1", "user-a", 1, 1);
      expect(await store.hasReservation("arena-1", "user-a")).toBe(true);

      now += 2_000;
      expect(await store.hasReservation("arena-1", "user-a")).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it("is false for a user who never reserved", async () => {
    const { store } = makeStore();
    expect(await store.hasReservation("arena-1", "stranger")).toBe(false);
  });
});
