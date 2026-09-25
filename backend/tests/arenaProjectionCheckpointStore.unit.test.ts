import { PrismaClient } from "@prisma/client";
import {
  ArenaProjectionCheckpointStore,
  CorruptCheckpointError,
  LeaseHeldError,
} from "../src/services/projection/arenaProjectionCheckpointStore";
import { foldArenaProjectionEvent, initialArenaProjection } from "../src/services/projection/arenaProjectionFold";

const prisma = new PrismaClient();
const store = new ArenaProjectionCheckpointStore(prisma);

const NETWORK_A = "Test SDF Network ; September 2015";
const NETWORK_B = "Public Global Stellar Network ; September 2015";

function arenaId(suffix: string) {
  return `CCHECKPOINT${suffix.padEnd(44, "0")}`.slice(0, 56);
}

async function cleanup(id: string) {
  await prisma.arenaProjectionCheckpoint.deleteMany({ where: { arenaId: id } });
}

describe("ArenaProjectionCheckpointStore", () => {
  it("load() returns null when no checkpoint row exists (genesis case)", async () => {
    if (!process.env.DATABASE_URL) return;
    const id = arenaId("A1");
    try {
      const result = await store.load(id, NETWORK_A);
      expect(result).toBeNull();
    } finally {
      await cleanup(id);
    }
  });

  it("save() then load() round-trips the full projection state", async () => {
    if (!process.env.DATABASE_URL) return;
    const id = arenaId("A2");
    try {
      const state = foldArenaProjectionEvent(initialArenaProjection(id), {
        id: "e1",
        contractId: id,
        ledgerSequence: 42,
        ledgerClosedAt: new Date().toISOString(),
        txHash: "tx-e1",
        topic: "JOIN",
        player: "GPLAYER1",
      });

      await store.save(id, NETWORK_A, state, "replaying");
      const loaded = await store.load(id, NETWORK_A);

      expect(loaded).not.toBeNull();
      expect(loaded?.lastLedgerSequence).toBe(42);
      expect(loaded?.status).toBe("replaying");
      expect(loaded?.projectionState).toEqual(state);
    } finally {
      await cleanup(id);
    }
  });

  it("save() upserts — a second save advances the checkpoint in place rather than creating a new row", async () => {
    if (!process.env.DATABASE_URL) return;
    const id = arenaId("A3");
    try {
      const state1 = foldArenaProjectionEvent(initialArenaProjection(id), {
        id: "e1",
        contractId: id,
        ledgerSequence: 1,
        ledgerClosedAt: new Date().toISOString(),
        txHash: "tx-e1",
        topic: "JOIN",
        player: "GPLAYER1",
      });
      await store.save(id, NETWORK_A, state1, "replaying");

      const state2 = foldArenaProjectionEvent(state1, {
        id: "e2",
        contractId: id,
        ledgerSequence: 2,
        ledgerClosedAt: new Date().toISOString(),
        txHash: "tx-e2",
        topic: "JOIN",
        player: "GPLAYER2",
      });
      await store.save(id, NETWORK_A, state2, "caught_up");

      const rows = await prisma.arenaProjectionCheckpoint.findMany({ where: { arenaId: id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.lastLedgerSequence).toBe(2);
      expect(rows[0]?.status).toBe("caught_up");
    } finally {
      await cleanup(id);
    }
  });

  it("scopes checkpoints per network — testnet and mainnet rows for the same arenaId never collide", async () => {
    if (!process.env.DATABASE_URL) return;
    const id = arenaId("A4");
    try {
      const testnetState = foldArenaProjectionEvent(initialArenaProjection(id), {
        id: "tn1",
        contractId: id,
        ledgerSequence: 10,
        ledgerClosedAt: new Date().toISOString(),
        txHash: "tx-tn1",
        topic: "JOIN",
        player: "GTESTNET_PLAYER",
      });
      const mainnetState = foldArenaProjectionEvent(initialArenaProjection(id), {
        id: "mn1",
        contractId: id,
        ledgerSequence: 99,
        ledgerClosedAt: new Date().toISOString(),
        txHash: "tx-mn1",
        topic: "JOIN",
        player: "GMAINNET_PLAYER",
      });

      await store.save(id, NETWORK_A, testnetState, "caught_up");
      await store.save(id, NETWORK_B, mainnetState, "caught_up");

      const loadedTestnet = await store.load(id, NETWORK_A);
      const loadedMainnet = await store.load(id, NETWORK_B);

      expect(loadedTestnet?.lastLedgerSequence).toBe(10);
      expect(loadedTestnet?.projectionState.players).toEqual(["GTESTNET_PLAYER"]);
      expect(loadedMainnet?.lastLedgerSequence).toBe(99);
      expect(loadedMainnet?.projectionState.players).toEqual(["GMAINNET_PLAYER"]);
    } finally {
      await prisma.arenaProjectionCheckpoint.deleteMany({ where: { arenaId: id } });
    }
  });

  it("load() throws CorruptCheckpointError when projectionState JSON doesn't match the expected shape", async () => {
    if (!process.env.DATABASE_URL) return;
    const id = arenaId("A5");
    try {
      await prisma.arenaProjectionCheckpoint.create({
        data: {
          arenaId: id,
          network: NETWORK_A,
          lastLedgerSequence: 1,
          projectionState: { totallyWrongShape: true },
          status: "idle",
        },
      });

      await expect(store.load(id, NETWORK_A)).rejects.toThrow(CorruptCheckpointError);
    } finally {
      await cleanup(id);
    }
  });

  it("markFailed() sets status/lastError without touching lastLedgerSequence/projectionState", async () => {
    if (!process.env.DATABASE_URL) return;
    const id = arenaId("A6");
    try {
      const state = foldArenaProjectionEvent(initialArenaProjection(id), {
        id: "e1",
        contractId: id,
        ledgerSequence: 7,
        ledgerClosedAt: new Date().toISOString(),
        txHash: "tx-e1",
        topic: "JOIN",
        player: "GPLAYER1",
      });
      await store.save(id, NETWORK_A, state, "replaying");

      await store.markFailed(id, NETWORK_A, "RPC timeout after 3 retries");

      const loaded = await store.load(id, NETWORK_A);
      expect(loaded?.status).toBe("failed");
      expect(loaded?.lastError).toBe("RPC timeout after 3 retries");
      expect(loaded?.lastLedgerSequence).toBe(7); // preserved — last good position not lost
    } finally {
      await cleanup(id);
    }
  });

  describe("lease claiming (concurrency guard)", () => {
    it("claimLease() creates a fresh row under the lease when none exists yet", async () => {
      if (!process.env.DATABASE_URL) return;
      const id = arenaId("B1");
      try {
        const owner = await store.claimLease(id, NETWORK_A, 60_000);
        expect(owner).toBeTruthy();

        const row = await prisma.arenaProjectionCheckpoint.findUnique({
          where: { arenaId_network: { arenaId: id, network: NETWORK_A } },
        });
        expect(row?.leaseOwner).toBe(owner);
        expect(row?.status).toBe("replaying");
      } finally {
        await cleanup(id);
      }
    });

    it("a second claimLease() for the same arena/network while the first lease is active throws LeaseHeldError", async () => {
      if (!process.env.DATABASE_URL) return;
      const id = arenaId("B2");
      try {
        const owner1 = await store.claimLease(id, NETWORK_A, 60_000);
        expect(owner1).toBeTruthy();

        await expect(store.claimLease(id, NETWORK_A, 60_000)).rejects.toThrow(LeaseHeldError);
      } finally {
        await cleanup(id);
      }
    });

    it("claimLease() succeeds once the prior lease has expired", async () => {
      if (!process.env.DATABASE_URL) return;
      const id = arenaId("B3");
      try {
        // Claim with a lease that's already expired (negative TTL).
        await store.claimLease(id, NETWORK_A, -1);

        const owner2 = await store.claimLease(id, NETWORK_A, 60_000);
        expect(owner2).toBeTruthy();

        const row = await prisma.arenaProjectionCheckpoint.findUnique({
          where: { arenaId_network: { arenaId: id, network: NETWORK_A } },
        });
        expect(row?.leaseOwner).toBe(owner2);
      } finally {
        await cleanup(id);
      }
    });

    it("releaseLease() clears the lease so a subsequent claim succeeds immediately", async () => {
      if (!process.env.DATABASE_URL) return;
      const id = arenaId("B4");
      try {
        const owner1 = await store.claimLease(id, NETWORK_A, 60_000);
        await store.releaseLease(id, NETWORK_A, owner1);

        const owner2 = await store.claimLease(id, NETWORK_A, 60_000);
        expect(owner2).toBeTruthy();
      } finally {
        await cleanup(id);
      }
    });

    it("renewLease() extends leaseExpiresAt for the current holder", async () => {
      if (!process.env.DATABASE_URL) return;
      const id = arenaId("B5");
      try {
        const owner = await store.claimLease(id, NETWORK_A, 1_000);
        const before = await prisma.arenaProjectionCheckpoint.findUnique({
          where: { arenaId_network: { arenaId: id, network: NETWORK_A } },
        });

        await store.renewLease(id, NETWORK_A, owner, 60_000);

        const after = await prisma.arenaProjectionCheckpoint.findUnique({
          where: { arenaId_network: { arenaId: id, network: NETWORK_A } },
        });
        expect(after?.leaseExpiresAt?.getTime()).toBeGreaterThan(
          before?.leaseExpiresAt?.getTime() ?? 0,
        );
      } finally {
        await cleanup(id);
      }
    });

    it("releaseLease() for a stale/mismatched owner is a no-op (does not clear another holder's active lease)", async () => {
      if (!process.env.DATABASE_URL) return;
      const id = arenaId("B6");
      try {
        const owner = await store.claimLease(id, NETWORK_A, 60_000);
        await store.releaseLease(id, NETWORK_A, "some-other-owner-id");

        const row = await prisma.arenaProjectionCheckpoint.findUnique({
          where: { arenaId_network: { arenaId: id, network: NETWORK_A } },
        });
        expect(row?.leaseOwner).toBe(owner); // untouched
      } finally {
        await cleanup(id);
      }
    });
  });
});
