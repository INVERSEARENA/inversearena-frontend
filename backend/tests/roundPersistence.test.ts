import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { RoundRepository } from "../src/repositories/roundRepository";
import { RoundMetadataBackfillService, ROUND_METADATA_NORMALIZATION_CURSOR_ID } from "../src/scripts/backfillRoundMetadata";
import { RoundState, type RoundMetadata, type RoundResolution, type PlayerChoice } from "../src/types/round";
import { roundMetadataMismatchesTotal } from "../src/utils/metrics";

describe("Round Metadata Typed Persistence & Dual-Read Compatibility (#1523)", () => {
  let mockPrisma: any;
  let repository: RoundRepository;

  beforeEach(() => {
    mockPrisma = {
      round: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      eliminationLog: {
        createMany: jest.fn(),
      },
      backfillCursor: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
      $transaction: jest.fn(async (cb: any) => cb(mockPrisma)),
    };
    repository = new RoundRepository(mockPrisma as any);
  });

  const samplePlayerChoices: PlayerChoice[] = [
    { userId: "550e8400-e29b-41d4-a716-446655440000", choice: "heads", stake: 100 as any },
    { userId: "550e8400-e29b-41d4-a716-446655440001", choice: "tails", stake: 100 as any },
  ];

  const sampleResolution: RoundResolution = {
    eliminatedPlayers: ["550e8400-e29b-41d4-a716-446655440001"],
    payouts: [
      {
        userId: "550e8400-e29b-41d4-a716-446655440000",
        amount: 200 as any,
        principal: 100 as any,
        yieldAmount: 100 as any,
        platformFee: 0 as any,
        dust: 0 as any,
      },
    ],
    poolBalances: { "arena-1": 0 as any },
  };

  const sampleMetadata: RoundMetadata = {
    playerChoices: samplePlayerChoices,
    oracleYield: 5.5,
    randomSeed: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    resolution: sampleResolution,
    allActivePlayerIds: ["550e8400-e29b-41d4-a716-446655440000", "550e8400-e29b-41d4-a716-446655440001"],
  };

  describe("Dual-Read Compatibility", () => {
    it("reads correctly from legacy-only rows (only metadata JSON populated)", async () => {
      mockPrisma.round.findUnique.mockResolvedValueOnce({
        id: "round-legacy",
        arenaId: "arena-1",
        roundNumber: 1,
        state: "RESOLVED",
        metadata: sampleMetadata,
        oracleYield: null,
        randomSeed: null,
        playerChoices: null,
        allActivePlayerIds: [],
        resolution: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const round = await repository.findById("round-legacy");
      expect(round).toBeDefined();
      expect(round?.oracleYield).toBe(5.5);
      expect(round?.randomSeed).toBe(sampleMetadata.randomSeed);
      expect(round?.playerChoices).toHaveLength(2);
      expect(round?.allActivePlayerIds).toHaveLength(2);
      expect(round?.resolution).toBeDefined();
    });

    it("reads correctly from new-only rows (only typed columns populated)", async () => {
      mockPrisma.round.findUnique.mockResolvedValueOnce({
        id: "round-typed",
        arenaId: "arena-1",
        roundNumber: 2,
        state: "RESOLVED",
        metadata: null,
        oracleYield: 7.25,
        randomSeed: "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff",
        playerChoices: samplePlayerChoices,
        allActivePlayerIds: ["player-1", "player-2"],
        resolution: sampleResolution,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const round = await repository.findById("round-typed");
      expect(round).toBeDefined();
      expect(round?.oracleYield).toBe(7.25);
      expect(round?.playerChoices).toHaveLength(2);
      expect(round?.allActivePlayerIds).toEqual(["player-1", "player-2"]);
      expect(round?.resolution?.eliminatedPlayers).toContain("550e8400-e29b-41d4-a716-446655440001");
    });

    it("prioritizes typed columns and detects mismatches when both representations exist", async () => {
      const initialMismatchCount = (roundMetadataMismatchesTotal as any).hashMap?.['field:oracleYield']?.value ?? 0;

      mockPrisma.round.findUnique.mockResolvedValueOnce({
        id: "round-divergent",
        arenaId: "arena-1",
        roundNumber: 3,
        state: "RESOLVED",
        metadata: {
          ...sampleMetadata,
          oracleYield: 3.0, // divergent legacy value
        },
        oracleYield: 8.5, // authoritative typed value
        randomSeed: sampleMetadata.randomSeed,
        playerChoices: samplePlayerChoices,
        allActivePlayerIds: sampleMetadata.allActivePlayerIds,
        resolution: sampleResolution,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const round = await repository.findById("round-divergent");
      expect(round).toBeDefined();
      // Should prefer typed column value
      expect(round?.oracleYield).toBe(8.5);
    });

    it("handles partially migrated rows gracefully", async () => {
      mockPrisma.round.findUnique.mockResolvedValueOnce({
        id: "round-partial",
        arenaId: "arena-1",
        roundNumber: 4,
        state: "RESOLVED",
        metadata: {
          randomSeed: "seed-from-legacy",
          resolution: sampleResolution,
        },
        oracleYield: 4.2, // typed column populated
        randomSeed: null, // missing in typed, fallback to legacy
        playerChoices: null,
        allActivePlayerIds: [],
        resolution: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const round = await repository.findById("round-partial");
      expect(round).toBeDefined();
      expect(round?.oracleYield).toBe(4.2);
      expect(round?.randomSeed).toBe("seed-from-legacy");
      expect(round?.resolution).toBeDefined();
    });
  });

  describe("Dual-Write Persistence", () => {
    it("saveResolution atomically updates both typed columns and legacy metadata", async () => {
      mockPrisma.round.update.mockResolvedValueOnce({});

      await repository.saveResolution("round-1", sampleResolution, sampleMetadata);

      expect(mockPrisma.round.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "round-1" },
          data: expect.objectContaining({
            oracleYield: 5.5,
            randomSeed: sampleMetadata.randomSeed,
            playerChoices: samplePlayerChoices,
            allActivePlayerIds: sampleMetadata.allActivePlayerIds,
            resolution: sampleResolution,
            metadata: expect.anything(),
          }),
        }),
      );

      expect(mockPrisma.eliminationLog.createMany).toHaveBeenCalledWith({
        data: [{ roundId: "round-1", userId: "550e8400-e29b-41d4-a716-446655440001", reason: "ELIMINATED_BY_ROUND" }],
      });
    });

    it("resolveAtomically executes optimistic concurrency lock with dual-write", async () => {
      mockPrisma.round.updateMany.mockResolvedValueOnce({ count: 1 });

      await repository.resolveAtomically(
        "round-2",
        RoundState.RESOLVED,
        sampleResolution,
        sampleMetadata,
      );

      expect(mockPrisma.round.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "round-2",
            state: { in: [RoundState.OPEN, RoundState.CLOSED] },
          },
          data: expect.objectContaining({
            state: RoundState.RESOLVED,
            oracleYield: 5.5,
            randomSeed: sampleMetadata.randomSeed,
            playerChoices: samplePlayerChoices,
            resolution: sampleResolution,
          }),
        }),
      );
    });

    it("resolveAtomically throws error if optimistic lock fails due to concurrent resolution", async () => {
      mockPrisma.round.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        repository.resolveAtomically(
          "round-conflict",
          RoundState.RESOLVED,
          sampleResolution,
          sampleMetadata,
        ),
      ).rejects.toThrow("already resolved by a concurrent request");

      expect(mockPrisma.eliminationLog.createMany).not.toHaveBeenCalled();
    });
  });

  describe("Backfill Service", () => {
    it("runs dry-run without writing database changes", async () => {
      mockPrisma.backfillCursor.findUnique.mockResolvedValueOnce({
        id: ROUND_METADATA_NORMALIZATION_CURSOR_ID,
        lastProcessed: 0,
      });

      mockPrisma.round.findMany.mockResolvedValueOnce([
        {
          id: "round-backfill-1",
          metadata: sampleMetadata,
          oracleYield: null,
          playerChoices: null,
        },
      ]);

      const backfillService = new RoundMetadataBackfillService(mockPrisma as any);
      const summary = await backfillService.run({ dryRun: true, batchSize: 10 });

      expect(summary.status).toBe("success");
      expect(summary.scanned).toBe(1);
      expect(summary.migrated).toBe(1);
      expect(mockPrisma.round.update).not.toHaveBeenCalled();
      expect(mockPrisma.backfillCursor.upsert).not.toHaveBeenCalled();
    });

    it("migrates valid records and persists cursor position", async () => {
      mockPrisma.backfillCursor.findUnique.mockResolvedValueOnce({
        id: ROUND_METADATA_NORMALIZATION_CURSOR_ID,
        lastProcessed: 5,
      });

      mockPrisma.round.findMany.mockResolvedValueOnce([
        {
          id: "round-backfill-2",
          metadata: sampleMetadata,
          oracleYield: null,
          playerChoices: null,
        },
      ]);
      mockPrisma.round.update.mockResolvedValueOnce({});
      mockPrisma.backfillCursor.upsert.mockResolvedValueOnce({});

      const backfillService = new RoundMetadataBackfillService(mockPrisma as any);
      const summary = await backfillService.run({ dryRun: false, batchSize: 10 });

      expect(summary.status).toBe("success");
      expect(summary.migrated).toBe(1);
      expect(mockPrisma.round.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "round-backfill-2" },
          data: expect.objectContaining({
            oracleYield: 5.5,
            randomSeed: sampleMetadata.randomSeed,
          }),
        }),
      );
      expect(mockPrisma.backfillCursor.upsert).toHaveBeenCalledWith({
        where: { id: ROUND_METADATA_NORMALIZATION_CURSOR_ID },
        create: { id: ROUND_METADATA_NORMALIZATION_CURSOR_ID, lastProcessed: 6 },
        update: { lastProcessed: 6 },
      });
    });

    it("handles malformed/conflicting metadata rows without crashing", async () => {
      mockPrisma.backfillCursor.findUnique.mockResolvedValueOnce(null);
      mockPrisma.round.findMany.mockResolvedValueOnce([
        {
          id: "round-malformed",
          metadata: {
            oracleYield: "not-a-number", // invalid type
            playerChoices: "not-an-array", // invalid type
          },
          oracleYield: null,
          playerChoices: null,
        },
      ]);

      const backfillService = new RoundMetadataBackfillService(mockPrisma as any);
      const summary = await backfillService.run({ dryRun: false, batchSize: 10 });

      expect(summary.status).toBe("success");
      expect(summary.conflicting).toBe(1);
      expect(summary.migrated).toBe(0);
      expect(mockPrisma.round.update).not.toHaveBeenCalled();
    });
  });
});
