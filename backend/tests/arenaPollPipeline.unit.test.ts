import {
  canonicalizeArenaSnapshot,
  createArenaPollStages,
  fingerprintArenaSnapshot,
  runArenaPollStages,
  stableStringify,
  verifyArenaSnapshot,
  type ArenaSnapshot,
  type ArenaSnapshotMeta,
} from "../src/cache/arenaPollPipeline";
import { planReplay } from "../src/cache/arenaPoller";
import { cache } from "../src/cache/cacheService";

jest.mock("../src/cache/cacheService", () => {
  const actual = jest.requireActual("../src/cache/cacheService");
  return {
    ...actual,
    cache: {
      get: jest.fn(),
      set: jest.fn(),
      setIfGenerationIsNewer: jest.fn(),
      del: jest.fn(),
    },
  };
});

const mockedCacheGet = cache.get as jest.Mock;
const mockedCacheSet = cache.set as jest.Mock;
const mockedGenerationWrite = cache.setIfGenerationIsNewer as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

function buildSnapshot(overrides: Partial<ArenaSnapshot> = {}): ArenaSnapshot {
  return {
    arenaId: "arena-1",
    currentRound: 3,
    playerCount: 12,
    survivorCount: 7,
    status: "active",
    recentEliminations: [
      { id: "el-1", userId: "U1", roundNumber: 2, reason: "lost", eliminatedAt: "2026-09-01T00:00:00.000Z" },
      { id: "el-2", userId: "U2", roundNumber: 2, reason: null, eliminatedAt: "2026-09-01T00:00:01.000Z" },
    ],
    lastRoundState: "OPEN",
    ...overrides,
  } as ArenaSnapshot;
}

interface Harness {
  published: Array<{ snapshot: ArenaSnapshot; meta: ArenaSnapshotMeta }>;
  heartbeats: ArenaSnapshotMeta[];
  persists: Array<{ snapshot: ArenaSnapshot; meta: ArenaSnapshotMeta }>;
  next: () => ArenaSnapshot;
  run: (hash?: (input: string) => string) => Promise<ReturnType<typeof runArenaPollStages>>;
  store: Map<string, unknown>;
  generations: Map<string, number>;
}

function buildHarness(initial?: ArenaSnapshot): Harness {
  let current = initial ?? buildSnapshot();
  const published: Harness["published"] = [];
  const heartbeats: Harness["heartbeats"] = [];
  const persists: Harness["persists"] = [];
  const store = new Map<string, unknown>();
  const generations = new Map<string, number>();

  const harness: Harness = {
    published,
    heartbeats,
    persists,
    store,
    generations,
    next: () => current,
    run: async (hash) => {
      const stages = createArenaPollStages(
        "arena-1",
        { getSnapshot: async () => current } as never,
        async (snapshot, meta) => {
          published.push({ snapshot, meta });
        },
        {
          persist: async (snapshot, meta) => {
            persists.push({ snapshot, meta });
            // Mirror the generation-guarded cache write: a stale generation
            // never overwrites a newer one.
            const key = "meta";
            const existing = generations.get(key) ?? -1;
            if (meta.version >= existing) {
              generations.set(key, meta.version);
              store.set(key, meta);
            }
          },
          heartbeat: async (meta) => {
            heartbeats.push(meta);
            store.set("meta", meta);
          },
        },
      );
      return runArenaPollStages(stages, hash);
    },
  };
  return harness;
}

describe("canonical snapshot fingerprint (#1500)", () => {
  it("produces a stable fingerprint that excludes transport volatility", () => {
    const a = buildSnapshot();
    const b = buildSnapshot();
    expect(canonicalizeArenaSnapshot(a)).toBe(canonicalizeArenaSnapshot(b));
    expect(fingerprintArenaSnapshot(a).fingerprint).toBe(fingerprintArenaSnapshot(b).fingerprint);
  });

  it("changes the fingerprint when any user-visible field changes", () => {
    const base = fingerprintArenaSnapshot(buildSnapshot()).fingerprint;
    const mutations: Array<Partial<ArenaSnapshot>> = [
      { currentRound: 4 },
      { playerCount: 11 },
      { survivorCount: 6 },
      { status: "settled" },
      { lastRoundState: "RESOLVED" },
      { recentEliminations: [{ id: "el-3", userId: "U3", roundNumber: 3, reason: "lost", eliminatedAt: "2026-09-01T00:00:02.000Z" }] },
    ];
    for (const mutation of mutations) {
      expect(fingerprintArenaSnapshot(buildSnapshot(mutation)).fingerprint).not.toBe(base);
    }
  });

  it("sorts object keys at every depth (deterministic serialization)", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });

  it("rejects snapshots that fail identity verification", () => {
    expect(() => verifyArenaSnapshot("arena-1", buildSnapshot({ arenaId: "other" }))).toThrow();
    expect(() => verifyArenaSnapshot("arena-1", buildSnapshot({ currentRound: Number.NaN }))).toThrow();
  });
});

describe("semantic publication gate (#1500)", () => {
  it("publishes the first verified snapshot at version 1 with no previous version", async () => {
    const harness = buildHarness();
    const outcome = await harness.run();

    expect(outcome.kind).toBe("published");
    expect(outcome.meta.version).toBe(1);
    expect(outcome.meta.previousVersion).toBeNull();
    expect(harness.published).toHaveLength(1);
    expect(harness.persists).toHaveLength(1);
    expect(harness.heartbeats).toHaveLength(0);
  });

  it("suppresses an unchanged poll: no persist, no publish, heartbeat only", async () => {
    const harness = buildHarness();
    await harness.run();
    const first = harness.store.get("meta") as ArenaSnapshotMeta;

    const outcome = await harness.run();

    expect(outcome.kind).toBe("suppressed");
    expect(harness.persists).toHaveLength(1); // unchanged poll wrote no snapshot
    expect(harness.published).toHaveLength(1); // unchanged poll published nothing
    expect(harness.heartbeats).toHaveLength(1);
    expect(outcome.meta.version).toBe(first.version);
    expect(new Date(outcome.meta.heartbeatAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.heartbeatAt).getTime(),
    );
  });

  it("publishes a one-field change as the next monotonic version", async () => {
    const harness = buildHarness();
    await harness.run();

    harness.next().survivorCount = 6; // one-field change
    const outcome = await harness.run();

    expect(outcome.kind).toBe("published");
    expect(outcome.meta.version).toBe(2);
    expect(outcome.meta.previousVersion).toBe(1);
    expect(harness.published).toHaveLength(2);
  });

  it("does not treat elimination-feed ordering as a semantic change", async () => {
    const harness = buildHarness();
    await harness.run();

    const reordered = harness.next();
    reordered.recentEliminations = [...reordered.recentEliminations].reverse();
    const outcome = await harness.run();

    expect(outcome.kind).toBe("suppressed");
  });

  it("keeps versions monotonic across sequential polls", async () => {
    const harness = buildHarness();
    const versions: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      if (i > 0) harness.next().playerCount = 12 + i;
      const outcome = await harness.run();
      versions.push(outcome.meta.version);
    }
    expect(versions).toEqual([1, 2, 3, 4, 5]);
  });

  it("an ordering race cannot roll persisted state back to an older generation", async () => {
    // Another writer advanced the shared store to v5 between this writer's
    // load (which saw a stale v2) and its persist of v3.
    const stale: ArenaSnapshotMeta = {
      arenaId: "arena-1",
      version: 2,
      previousVersion: 1,
      fingerprint: "stale",
      canonical: "stale",
      persistedAt: "2026-09-01T00:00:00.000Z",
      heartbeatAt: "2026-09-01T00:00:00.000Z",
    };
    const newer: ArenaSnapshotMeta = { ...stale, version: 5, previousVersion: 4 };
    const store = new Map<string, unknown>([["meta", newer]]);
    const generations = new Map<string, number>([["meta", 5]]);
    const persists: ArenaSnapshotMeta[] = [];

    const stages = createArenaPollStages(
      "arena-1",
      { getSnapshot: async () => buildSnapshot() } as never,
      async () => undefined,
      {
        load: async () => stale,
        persist: async (_snapshot, meta) => {
          const existing = generations.get("meta") ?? -1;
          if (meta.version >= existing) {
            generations.set("meta", meta.version);
            store.set("meta", meta);
          }
          persists.push(meta);
        },
      },
    );

    const outcome = await runArenaPollStages(stages);

    expect(outcome.meta.version).toBe(3);
    expect(persists).toHaveLength(1);
    // The stale v3 write was rejected — the store still holds v5.
    expect((store.get("meta") as ArenaSnapshotMeta).version).toBe(5);
    expect(generations.get("meta")).toBe(5);
  });

  it("resumes versions from persisted metadata after a process restart", async () => {
    const persisted: ArenaSnapshotMeta = {
      arenaId: "arena-1",
      version: 4,
      previousVersion: 3,
      fingerprint: "prior",
      canonical: "prior",
      persistedAt: "2026-09-01T00:00:00.000Z",
      heartbeatAt: "2026-09-01T00:00:00.000Z",
    };
    mockedCacheGet.mockResolvedValue(persisted);

    const stages = createArenaPollStages(
      "arena-1",
      { getSnapshot: async () => buildSnapshot() } as never,
      async () => undefined,
    );
    const outcome = await runArenaPollStages(stages);

    expect(outcome.meta.version).toBe(5);
    expect(outcome.meta.previousVersion).toBe(4);
  });

  it("survives a hash collision fixture: the canonical payload is authoritative", async () => {
    const collidingHash = () => "deadbeef";
    const harness = buildHarness();
    await harness.run(collidingHash);

    harness.next().playerCount = 99; // real change, deliberately colliding hash
    const outcome = await harness.run(collidingHash);

    expect(outcome.kind).toBe("published");
    expect(outcome.meta.version).toBe(2);
    expect(outcome.meta.fingerprint).toBe("deadbeef");
    expect(harness.published).toHaveLength(2);
  });

  it("uses generation-guarded cache writes on publish and a metadata write on heartbeat", async () => {
    mockedCacheGet.mockResolvedValue(null);
    mockedGenerationWrite.mockResolvedValue(true);
    mockedCacheSet.mockResolvedValue(undefined);

    const stages = createArenaPollStages("arena-1", { getSnapshot: async () => buildSnapshot() } as never);
    const first = await runArenaPollStages(stages);

    expect(first.kind).toBe("published");
    expect(mockedGenerationWrite).toHaveBeenCalledTimes(2);
    expect(mockedGenerationWrite).toHaveBeenCalledWith(
      "arena:verified-snapshot:arena-1",
      expect.objectContaining({ snapshot: expect.any(Object), meta: expect.any(Object) }),
      1,
      expect.any(Number),
    );
    expect(mockedGenerationWrite).toHaveBeenCalledWith(
      "arena:snapshot-meta:arena-1",
      expect.objectContaining({ version: 1 }),
      1,
      expect.any(Number),
    );
    expect(mockedCacheSet).not.toHaveBeenCalled();

    // An unchanged follow-up poll refreshes only the heartbeat metadata.
    mockedCacheGet.mockResolvedValue(first.meta);
    const second = await runArenaPollStages(stages);
    expect(second.kind).toBe("suppressed");
    expect(mockedCacheSet).toHaveBeenCalledTimes(1);
    expect(mockedCacheSet).toHaveBeenCalledWith(
      "arena:snapshot-meta:arena-1",
      expect.objectContaining({ version: 1 }),
      expect.any(Number),
    );
  });
});

describe("stale client recovery plan (#1500)", () => {
  const envelope = (sequence: number) => ({ seq: sequence });
  const history = [1, 2, 3].map((sequence) => ({ event: "evt", payload: envelope(sequence), sequence }));
  const lastSnapshot = { payload: envelope(3), sequence: 3 };

  it("replays missed events in order when the cursor is still covered", () => {
    const plan = planReplay(lastSnapshot, history, 3, 1);
    expect(plan.kind).toBe("replay");
    if (plan.kind === "replay") {
      expect(plan.items.map((item) => item.sequence)).toEqual([2, 3]);
    }
  });

  it("falls back to a full snapshot when the cursor fell out of history", () => {
    const staleHistory = history.slice(0, 1);
    const plan = planReplay({ payload: envelope(99), sequence: 99 }, staleHistory, 99, 1);
    expect(plan.kind).toBe("snapshot");
    if (plan.kind === "snapshot") expect(plan.sequence).toBe(99);
  });

  it("sends nothing when the client is already current", () => {
    expect(planReplay(lastSnapshot, history, 3, 3).kind).toBe("none");
  });

  it("always sends a full snapshot to a cursorless client", () => {
    const plan = planReplay(lastSnapshot, history, 3, undefined);
    expect(plan.kind).toBe("snapshot");
  });

  it("sends nothing when no snapshot has been published yet", () => {
    expect(planReplay(null, [], 0, undefined).kind).toBe("none");
  });
});
