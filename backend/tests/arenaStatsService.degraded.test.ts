import { ArenaStatsService } from "../src/services/arenaStatsService";
import { getOnChainSnapshotOrThrow } from "../src/services/onChainReader";
import { getCurrentLedgerSequence } from "../src/services/ledgerClock";
import { cache } from "../src/cache/cacheService";
import { resetSorobanBreakerForTest } from "../src/utils/circuitBreaker";

jest.mock("../src/services/onChainReader", () => ({
  ...jest.requireActual("../src/services/onChainReader"),
  getOnChainSnapshotOrThrow: jest.fn(),
}));
jest.mock("../src/services/ledgerClock", () => ({
  getCurrentLedgerSequence: jest.fn(),
}));
jest.mock("../src/cache/cacheService", () => ({
  ...jest.requireActual("../src/cache/cacheService"),
  cache: { get: jest.fn(), set: jest.fn() },
}));

const mockedSnapshot = getOnChainSnapshotOrThrow as jest.Mock;
const mockedLedger = getCurrentLedgerSequence as jest.Mock;
const mockedCacheGet = cache.get as jest.Mock;
const mockedCacheSet = cache.set as jest.Mock;

function buildPrismaMock(overrides: {
  arenaMetadata: Record<string, unknown>;
  rounds?: Array<Record<string, unknown>>;
  poolCount?: number;
  eliminatedUserIds?: string[];
}) {
  const rounds = overrides.rounds ?? [];
  return {
    arena: {
      findUnique: jest.fn().mockResolvedValue({
        id: "arena-1",
        metadata: overrides.arenaMetadata,
        rounds,
      }),
    },
    pool: {
      count: jest.fn().mockResolvedValue(overrides.poolCount ?? 0),
    },
    eliminationLog: {
      findMany: jest
        .fn()
        .mockResolvedValue((overrides.eliminatedUserIds ?? []).map((userId) => ({ userId }))),
    },
  } as any;
}

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1";
const VAULT = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2";

beforeEach(() => {
  jest.clearAllMocks();
  resetSorobanBreakerForTest(); // isolate each test from the shared breaker's rolling failure count
});

describe("ArenaStatsService.getArenaStats degraded mode (#1408)", () => {
  it("returns a live snapshot and caches it when the on-chain read succeeds", async () => {
    mockedSnapshot.mockResolvedValue({ playerCount: 10, gameState: "InProgress", yieldAccrued: 42 });
    mockedLedger.mockResolvedValue(555);

    const prisma = buildPrismaMock({
      arenaMetadata: { contractAddress: CONTRACT, vaultContractAddress: VAULT },
    });
    const service = new ArenaStatsService(prisma);

    const stats = await service.getArenaStats("arena-1");

    expect(stats.degraded).toBe(false);
    expect(stats.playerCount).toBe(10);
    expect(stats.yieldAccrued).toBe(42);
    expect(stats.status).toBe("active");
    expect(stats.ledgerSequence).toBe(555);
    expect(stats.snapshotVerifiedAt).not.toBeNull();

    expect(mockedCacheSet).toHaveBeenCalledTimes(1);
    const [key, value] = mockedCacheSet.mock.calls[0];
    expect(key).toBe("arena:onchain-snapshot:arena-1");
    expect(value).toMatchObject({ playerCount: 10, yieldAccrued: 42, ledgerSequence: 555 });
  });

  it("serves the last verified snapshot, flagged as degraded, when the live read fails", async () => {
    mockedSnapshot.mockRejectedValue(new Error("Soroban RPC circuit is OPEN"));
    mockedCacheGet.mockResolvedValue({
      playerCount: 7,
      gameState: "Finished",
      yieldAccrued: 100,
      ledgerSequence: 400,
      verifiedAt: "2026-01-01T00:00:00.000Z",
    });

    const prisma = buildPrismaMock({
      arenaMetadata: { contractAddress: CONTRACT, vaultContractAddress: VAULT },
      rounds: [{ state: "SETTLED", roundNumber: 1, metadata: {} }],
    });
    const service = new ArenaStatsService(prisma);

    const stats = await service.getArenaStats("arena-1");

    expect(stats.degraded).toBe(true);
    expect(stats.playerCount).toBe(7);
    expect(stats.yieldAccrued).toBe(100);
    expect(stats.ledgerSequence).toBe(400);
    expect(stats.snapshotVerifiedAt).toBe("2026-01-01T00:00:00.000Z");
    // Finished + a SETTLED round in the DB -> settled, computed from the
    // degraded snapshot's gameState plus current (non-stale) DB data.
    expect(stats.status).toBe("settled");
  });

  it("never fabricates a snapshot: falls back to DB-derived values, unflagged, when nothing was ever verified", async () => {
    mockedSnapshot.mockRejectedValue(new Error("Soroban RPC circuit is OPEN"));
    mockedCacheGet.mockResolvedValue(null);

    const prisma = buildPrismaMock({
      arenaMetadata: { contractAddress: CONTRACT, vaultContractAddress: VAULT },
      poolCount: 3,
      rounds: [{ state: "OPEN", roundNumber: 1, metadata: {} }],
    });
    const service = new ArenaStatsService(prisma);

    const stats = await service.getArenaStats("arena-1");

    expect(stats.degraded).toBe(false);
    expect(stats.ledgerSequence).toBeNull();
    expect(stats.snapshotVerifiedAt).toBeNull();
    expect(stats.playerCount).toBe(3); // DB pool count fallback
    expect(stats.status).toBe("active"); // round-derived fallback
  });

  it("skips on-chain entirely (existing behavior) when the arena has no contract address", async () => {
    const prisma = buildPrismaMock({
      arenaMetadata: { minStake: 50 },
      poolCount: 2,
    });
    const service = new ArenaStatsService(prisma);

    const stats = await service.getArenaStats("arena-1");

    expect(mockedSnapshot).not.toHaveBeenCalled();
    expect(stats.degraded).toBe(false);
    expect(stats.ledgerSequence).toBeNull();
    expect(stats.playerCount).toBe(2);
  });
});
