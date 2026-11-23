import { ArenaStatusAndCreatorBackfillService } from "../../scripts/backfillArenaStatusAndCreator";
import { CreatorService } from "../creatorService";
import { ArenaQueryService } from "../arenaQueryService";

describe("Arena Status and Creator Column Promotion (#1765)", () => {
  describe("ArenaStatusAndCreatorBackfillService", () => {
    it("handles dry-run mode without modifying records", async () => {
      const mockArenas = [
        {
          id: "arena-1",
          status: "ACTIVE",
          createdBy: null,
          metadata: { status: "ACTIVE", createdBy: "GABC123" },
        },
      ];

      const mockPrisma: any = {
        arena: {
          findMany: jest.fn().mockResolvedValueOnce(mockArenas).mockResolvedValueOnce([]),
          update: jest.fn(),
        },
      };

      const backfill = new ArenaStatusAndCreatorBackfillService(mockPrisma);
      const summary = await backfill.run({ dryRun: true });

      expect(summary.status).toBe("success");
      expect(summary.scanned).toBe(1);
      expect(summary.updated).toBe(1);
      expect(mockPrisma.arena.update).not.toHaveBeenCalled();
    });

    it("backfills status and createdBy when live", async () => {
      const mockArenas = [
        {
          id: "arena-1",
          status: "ACTIVE",
          createdBy: null,
          metadata: { status: "CANCELLED", createdBy: "GABC123" },
        },
        {
          id: "arena-2",
          status: "ACTIVE",
          createdBy: "GDEF456",
          metadata: { status: "ACTIVE", createdBy: "GDEF456" },
        },
      ];

      const mockPrisma: any = {
        arena: {
          findMany: jest.fn().mockResolvedValueOnce(mockArenas).mockResolvedValueOnce([]),
          update: jest.fn().mockResolvedValue({}),
        },
      };

      const backfill = new ArenaStatusAndCreatorBackfillService(mockPrisma);
      const summary = await backfill.run({ dryRun: false });

      expect(summary.status).toBe("success");
      expect(summary.scanned).toBe(2);
      expect(summary.updated).toBe(1);
      expect(summary.skipped).toBe(1);
      expect(mockPrisma.arena.update).toHaveBeenCalledTimes(1);
      expect(mockPrisma.arena.update).toHaveBeenCalledWith({
        where: { id: "arena-1" },
        data: {
          status: "CANCELLED",
          createdBy: "GABC123",
        },
      });
    });

    it("gracefully handles rows with missing or malformed metadata", async () => {
      const mockArenas = [
        {
          id: "arena-bad-1",
          status: "ACTIVE",
          createdBy: null,
          metadata: null,
        },
        {
          id: "arena-bad-2",
          status: "ACTIVE",
          createdBy: null,
          metadata: "not-an-object",
        },
      ];

      const mockPrisma: any = {
        arena: {
          findMany: jest.fn().mockResolvedValueOnce(mockArenas).mockResolvedValueOnce([]),
          update: jest.fn().mockResolvedValue({}),
        },
      };

      const backfill = new ArenaStatusAndCreatorBackfillService(mockPrisma);
      const summary = await backfill.run({ dryRun: false });

      expect(summary.status).toBe("success");
      expect(summary.scanned).toBe(2);
      expect(summary.skipped).toBe(2);
      expect(summary.errors).toBe(0);
      expect(mockPrisma.arena.update).not.toHaveBeenCalled();
    });
  });

  describe("CreatorService queries use indexed columns", () => {
    it("queries by createdBy and optionally status", async () => {
      const mockPrisma: any = {
        arena: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };

      const service = new CreatorService(mockPrisma);
      await service.listCreatorArenas("GCREATOR123", 10, undefined, "ACTIVE");

      expect(mockPrisma.arena.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            createdBy: "GCREATOR123",
            status: "ACTIVE",
          },
        }),
      );
    });
  });

  describe("ArenaQueryService queries use indexed status column", () => {
    it("filters active arenas using typed status", async () => {
      const mockPrisma: any = {
        arena: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };

      const service = new ArenaQueryService(mockPrisma);
      await service.listArenas({ filter: "active" });

      expect(mockPrisma.arena.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: "ACTIVE",
          },
        }),
      );
    });
  });
});
