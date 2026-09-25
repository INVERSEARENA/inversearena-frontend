/**
 * Unit tests for the checkpointed replay engine (#1382). `onChainReader`'s
 * RPC-facing `getArenaEvents` is mocked (no real Soroban RPC in unit
 * tests); the checkpoint store runs against the real Postgres test DB, the
 * same way `arenaProjectionCheckpointStore.unit.test.ts` does, since the
 * behavior under test — restart-mid-replay safety, lease guarding,
 * checkpoint-per-batch — is precisely about what gets durably persisted.
 */
import { jest } from "@jest/globals";

jest.mock("../src/services/onChainReader", () => {
  const actual = jest.requireActual("../src/services/onChainReader") as object;
  return {
    ...actual,
    getArenaEvents: jest.fn(),
  };
});

import { PrismaClient } from "@prisma/client";
import { getArenaEvents } from "../src/services/onChainReader";
import {
  replayArenaProjection,
  DEFAULT_MAX_RETRIES,
} from "../src/services/projection/arenaProjectionReplay";
import { ArenaProjectionCheckpointStore, LeaseHeldError } from "../src/services/projection/arenaProjectionCheckpointStore";
import { foldArenaProjectionEvent, initialArenaProjection } from "../src/services/projection/arenaProjectionFold";
import type { ArenaProjectionEvent } from "../src/services/projection/arenaEventTypes";

const prisma = new PrismaClient();
const store = new ArenaProjectionCheckpointStore(prisma);
const mockGetArenaEvents = getArenaEvents as jest.MockedFunction<typeof getArenaEvents>;

// This backend's stellarConfig test defaults (see test/setup.ts / stellarConfig.ts)
// fall back to the testnet passphrase when STELLAR_NETWORK_PASSPHRASE is unset
// and NODE_ENV === "test".
const NETWORK = "Test SDF Network ; September 2015";

function arenaId(suffix: string) {
  return `CREPLAY${suffix.padEnd(48, "0")}`.slice(0, 56);
}

function joinEvent(id: string, ledger: number, player: string): ArenaProjectionEvent {
  return {
    id,
    contractId: "test",
    ledgerSequence: ledger,
    ledgerClosedAt: new Date().toISOString(),
    txHash: `tx-${id}`,
    topic: "JOIN",
    player,
  };
}

async function cleanup(id: string) {
  await prisma.arenaProjectionCheckpoint.deleteMany({ where: { arenaId: id } });
}

beforeEach(() => {
  mockGetArenaEvents.mockReset();
});

describe("replayArenaProjection", () => {
  it("replays from genesis when no checkpoint exists, across multiple pages, and marks caught_up", async () => {
    if (!process.env.DATABASE_URL) return;
    const id = arenaId("R1");
    try {
      mockGetArenaEvents
        .mockResolvedValueOnce({
          events: [joinEvent("e1", 1, "GPLAYER1"), joinEvent("e2", 2, "GPLAYER2")],
          latestLedger: 10,
          cursor: "cursor-1",
        })
        .mockResolvedValueOnce({
          events: [joinEvent("e3", 3, "GPLAYER3")],
          latestLedger: 10,
          cursor: null,
        });

      const result = await replayArenaProjection(prisma, id, { genesisLedger: 1, batchSize: 2 });

      expect(result.status).toBe("caught_up");
      expect(result.batchesProcessed).toBe(2);
      expect(result.eventsProcessed).toBe(3);
      expect(result.state.players).toEqual(["GPLAYER1", "GPLAYER2", "GPLAYER3"]);

      const checkpoint = await store.load(id, NETWORK);
      expect(checkpoint?.status).toBe("caught_up");
      expect(checkpoint?.lastLedgerSequence).toBe(3);
      expect(checkpoint?.leaseOwner).toBeNull(); // released on completion
    } finally {
      await cleanup(id);
    }
  });

  it("resumes from an existing checkpoint instead of re-fetching from genesis", async () => {
    if (!process.env.DATABASE_URL) return;
    const id = arenaId("R2");
    try {
      // Pre-seed a checkpoint as if a prior replay already got through ledger 5.
      const seeded = foldArenaProjectionEvent(
        initialArenaProjection(id),
        joinEvent("seed1", 5, "GEARLYPLAYER"),
      );
      await store.save(id, NETWORK, seeded, "caught_up");

      mockGetArenaEvents.mockResolvedValueOnce({
        events: [joinEvent("e6", 6, "GNEWPLAYER")],
        latestLedger: 6,
        cursor: null,
      });

      const result = await replayArenaProjection(prisma, id, {});

      // Must have requested starting strictly after the checkpointed ledger.
      expect(mockGetArenaEvents).toHaveBeenCalledWith(
        id,
        { startLedger: 6 },
        expect.any(Number),
      );
      expect(result.state.players).toEqual(["GEARLYPLAYER", "GNEWPLAYER"]);
    } finally {
      await cleanup(id);
    }
  });

  it("checkpoints after each batch — an interrupted replay resumes from the last committed batch, not from scratch", async () => {
    if (!process.env.DATABASE_URL) return;
    const id = arenaId("R3");
    try {
      // First run: batch 1 succeeds and checkpoints, batch 2 fails permanently.
      mockGetArenaEvents
        .mockResolvedValueOnce({
          events: [joinEvent("e1", 1, "GPLAYER1")],
          latestLedger: 20,
          cursor: "cursor-1",
        })
        .mockRejectedValue(new Error("simulated RPC outage"));

      await expect(
        replayArenaProjection(prisma, id, { genesisLedger: 1, batchSize: 1, maxRetries: 0 }),
      ).rejects.toThrow("simulated RPC outage");

      const afterFailure = await store.load(id, NETWORK);
      expect(afterFailure?.status).toBe("failed");
      expect(afterFailure?.lastLedgerSequence).toBe(1); // batch 1's progress preserved
      expect(afterFailure?.leaseOwner).toBeNull(); // lease released even on failure

      // Second run: RPC recovers. Replay must resume from ledger 2, not re-fetch from genesis.
      mockGetArenaEvents.mockReset();
      mockGetArenaEvents.mockResolvedValueOnce({
        events: [joinEvent("e2", 2, "GPLAYER2")],
        latestLedger: 20,
        cursor: null,
      });

      const result = await replayArenaProjection(prisma, id, { genesisLedger: 1, batchSize: 1 });

      expect(mockGetArenaEvents).toHaveBeenCalledWith(id, { startLedger: 2 }, expect.any(Number));
      expect(result.state.players).toEqual(["GPLAYER1", "GPLAYER2"]);
      expect(result.status).toBe("caught_up");
    } finally {
      await cleanup(id);
    }
  });

  it("retries a transient failure within a batch up to maxRetries before succeeding", async () => {
    if (!process.env.DATABASE_URL) return;
    const id = arenaId("R4");
    try {
      mockGetArenaEvents
        .mockRejectedValueOnce(new Error("transient"))
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce({
          events: [joinEvent("e1", 1, "GPLAYER1")],
          latestLedger: 1,
          cursor: null,
        });

      const result = await replayArenaProjection(prisma, id, {
        genesisLedger: 1,
        maxRetries: DEFAULT_MAX_RETRIES,
        sleep: async () => {}, // no real delay in tests
      });

      expect(mockGetArenaEvents).toHaveBeenCalledTimes(3);
      expect(result.status).toBe("caught_up");
      expect(result.state.players).toEqual(["GPLAYER1"]);
    } finally {
      await cleanup(id);
    }
  });

  it("a second concurrent replay for the same arena/network throws LeaseHeldError instead of racing", async () => {
    if (!process.env.DATABASE_URL) return;
    const id = arenaId("R5");
    try {
      // Simulate an in-progress replay by claiming the lease directly and never releasing it.
      await store.claimLease(id, NETWORK, 60_000);

      mockGetArenaEvents.mockResolvedValueOnce({
        events: [joinEvent("e1", 1, "GPLAYER1")],
        latestLedger: 1,
        cursor: null,
      });

      await expect(replayArenaProjection(prisma, id, { genesisLedger: 1 })).rejects.toThrow(
        LeaseHeldError,
      );
      // The RPC layer must never be called once the lease claim fails.
      expect(mockGetArenaEvents).not.toHaveBeenCalled();
    } finally {
      await cleanup(id);
    }
  });

  it("throws when no checkpoint exists and no genesisLedger is provided", async () => {
    if (!process.env.DATABASE_URL) return;
    const id = arenaId("R6");
    try {
      await expect(replayArenaProjection(prisma, id, {})).rejects.toThrow(/genesisLedger/);
    } finally {
      await cleanup(id);
    }
  });

  it("is idempotent under a full duplicate re-run: replaying an already-caught-up arena is a safe no-op", async () => {
    if (!process.env.DATABASE_URL) return;
    const id = arenaId("R7");
    try {
      mockGetArenaEvents.mockResolvedValueOnce({
        events: [joinEvent("e1", 1, "GPLAYER1")],
        latestLedger: 1,
        cursor: null,
      });
      const first = await replayArenaProjection(prisma, id, { genesisLedger: 1 });
      expect(first.state.players).toEqual(["GPLAYER1"]);

      // Re-running finds nothing new past ledger 1.
      mockGetArenaEvents.mockResolvedValueOnce({
        events: [],
        latestLedger: 1,
        cursor: null,
      });
      const second = await replayArenaProjection(prisma, id, {});

      expect(second.state).toEqual(first.state);
      expect(second.status).toBe("caught_up");
    } finally {
      await cleanup(id);
    }
  });
});
