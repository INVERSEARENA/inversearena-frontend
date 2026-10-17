/**
 * Integration test for #1382: onChainReader -> replay -> projection ->
 * arenaService, exercised end to end against the real Postgres test DB
 * (the RPC boundary — onChainReader.getArenaEvents — is mocked, since this
 * suite runs without a live Soroban RPC endpoint; everything downstream of
 * that boundary, including Prisma persistence, is real).
 */
import { jest } from "@jest/globals";

jest.mock("../../src/services/onChainReader", () => {
  const actual = jest.requireActual("../../src/services/onChainReader") as object;
  return {
    ...actual,
    getArenaEvents: jest.fn(),
  };
});

import { prisma } from "../../src/db/prisma";
import { getArenaEvents } from "../../src/services/onChainReader";
import { ArenaService } from "../../src/services/arenaService";
import type { ArenaProjectionEvent } from "../../src/services/projection/arenaEventTypes";

const mockGetArenaEvents = getArenaEvents as jest.MockedFunction<typeof getArenaEvents>;

const NETWORK = "Test SDF Network ; September 2015";
const ARENA_ID = "CINTEGRATION00000000000000000000000000000000000000000";

function ev(partial: Record<string, unknown>): ArenaProjectionEvent {
  return {
    contractId: ARENA_ID,
    ledgerClosedAt: new Date().toISOString(),
    ...partial,
  } as ArenaProjectionEvent;
}

async function cleanupCheckpoint() {
  await prisma.arenaProjectionCheckpoint.deleteMany({ where: { arenaId: ARENA_ID } });
}

describe("Arena projection integration: onChainReader -> replay -> projection -> arenaService", () => {
  beforeEach(() => {
    mockGetArenaEvents.mockReset();
  });

  afterEach(async () => {
    if (!process.env.DATABASE_URL) return;
    await cleanupCheckpoint();
  });

  it("replays a full arena lifecycle from genesis and serves it via ArenaService.getProjection", async () => {
    if (!process.env.DATABASE_URL) return;

    const arenaService = new ArenaService(prisma);

    // Simulate the on-chain event log for a small arena: init, two joins,
    // start, an elimination, finish, claim — spread across two RPC pages to
    // also exercise pagination end-to-end.
    mockGetArenaEvents
      .mockResolvedValueOnce({
        events: [
          ev({ id: "e1", ledgerSequence: 100, txHash: "tx1", topic: "INIT", admin: "GADMIN" }),
          ev({ id: "e2", ledgerSequence: 101, txHash: "tx2", topic: "JOIN", player: "GPLAYER1" }),
          ev({ id: "e3", ledgerSequence: 102, txHash: "tx3", topic: "JOIN", player: "GPLAYER2" }),
        ],
        latestLedger: 200,
        cursor: "page-2",
      })
      .mockResolvedValueOnce({
        events: [
          ev({ id: "e4", ledgerSequence: 103, txHash: "tx4", topic: "START" }),
          ev({ id: "e5", ledgerSequence: 104, txHash: "tx5", topic: "ELIM", player: "GPLAYER2" }),
          ev({ id: "e6", ledgerSequence: 105, txHash: "tx6", topic: "FINISH" }),
          ev({ id: "e7", ledgerSequence: 106, txHash: "tx7", topic: "CLAIMED", winner: "GPLAYER1" }),
        ],
        latestLedger: 200,
        cursor: null,
      });

    // Before any replay, getProjection reports "not_started" rather than a
    // misleading empty-but-caught-up state.
    const beforeReplay = await arenaService.getProjection(ARENA_ID);
    expect(beforeReplay.status).toBe("not_started");
    expect(beforeReplay.projection.gameState).toBe("unknown");

    const replayResult = await arenaService.triggerProjectionReplay(ARENA_ID, {
      genesisLedger: 100,
      batchSize: 3,
    });

    expect(replayResult.status).toBe("caught_up");
    expect(replayResult.batchesProcessed).toBe(2);
    expect(replayResult.eventsProcessed).toBe(7);

    const projection = await arenaService.getProjection(ARENA_ID);

    expect(projection.status).toBe("caught_up");
    expect(projection.network).toBe(NETWORK);
    expect(projection.lastLedgerSequence).toBe(106);
    expect(projection.projection.gameState).toBe("finished");
    expect(projection.projection.admin).toBe("GADMIN");
    expect(projection.projection.players).toEqual(["GPLAYER1", "GPLAYER2"]);
    expect(projection.projection.eliminated).toEqual(["GPLAYER2"]);
    expect(projection.projection.winner).toBe("GPLAYER1");
    expect(projection.projection.prizeClaimed).toBe(true);

    // Confirm it was actually durably persisted, not just held in the
    // ArenaService instance's memory — read the checkpoint row directly.
    const row = await prisma.arenaProjectionCheckpoint.findUnique({
      where: { arenaId_network: { arenaId: ARENA_ID, network: NETWORK } },
    });
    expect(row).not.toBeNull();
    expect(row?.status).toBe("caught_up");
    expect(row?.lastLedgerSequence).toBe(106);
  });

  it("a second replay call resumes from the checkpoint and only folds newly-arrived events", async () => {
    if (!process.env.DATABASE_URL) return;

    const arenaService = new ArenaService(prisma);

    mockGetArenaEvents.mockResolvedValueOnce({
      events: [
        ev({ id: "e1", ledgerSequence: 100, txHash: "tx1", topic: "INIT", admin: "GADMIN" }),
        ev({ id: "e2", ledgerSequence: 101, txHash: "tx2", topic: "JOIN", player: "GPLAYER1" }),
      ],
      latestLedger: 101,
      cursor: null,
    });

    const first = await arenaService.triggerProjectionReplay(ARENA_ID, { genesisLedger: 100 });
    expect(first.state.players).toEqual(["GPLAYER1"]);

    // A new player joins on-chain after the first replay caught up.
    mockGetArenaEvents.mockResolvedValueOnce({
      events: [ev({ id: "e3", ledgerSequence: 102, txHash: "tx3", topic: "JOIN", player: "GPLAYER2" })],
      latestLedger: 102,
      cursor: null,
    });

    const second = await arenaService.triggerProjectionReplay(ARENA_ID, {});

    // Must have asked onChainReader starting strictly after the checkpoint,
    // not from genesis again.
    expect(mockGetArenaEvents).toHaveBeenLastCalledWith(
      ARENA_ID,
      { startLedger: 102 },
      expect.any(Number),
    );
    expect(second.state.players).toEqual(["GPLAYER1", "GPLAYER2"]);

    const projection = await arenaService.getProjection(ARENA_ID);
    expect(projection.projection.players).toEqual(["GPLAYER1", "GPLAYER2"]);
  });

  it("getSnapshot() (the pre-existing REST/SSE contract) is unaffected by the projection subsystem existing", async () => {
    if (!process.env.DATABASE_URL) return;

    // Regression guard for the compatibility constraint in
    // docs/projection-checkpoint-replay.md: getSnapshot must keep reading
    // from the DB rounds/eliminations path, never from the projection.
    const arenaService = new ArenaService(prisma);
    const arena = await prisma.arena.create({ data: { metadata: { name: "Snapshot Test" } } });

    try {
      const snapshot = await arenaService.getSnapshot(arena.id);
      expect(snapshot.arenaId).toBe(arena.id);
      expect(snapshot.currentRound).toBe(0);
      expect(snapshot.playerCount).toBe(0);
      expect(snapshot.recentEliminations).toEqual([]);
      // getSnapshot must never have been influenced by projection mocks above.
      expect(mockGetArenaEvents).not.toHaveBeenCalled();
    } finally {
      await prisma.arena.delete({ where: { id: arena.id } });
    }
  });
});
