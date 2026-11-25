import { ArenaQueryService } from "../arenaQueryService";

describe("ArenaQueryService", () => {
  let mockPrisma: any;
  let service: ArenaQueryService;

  beforeEach(() => {
    mockPrisma = {
      arena: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "ARENA_1",
            createdAt: new Date("2026-06-01T12:00:00.000Z"),
            pools: [{ id: "p1" }],
            rounds: [],
            metadata: {
              number: "#0001",
              name: "Alpha Arena",
              maxPlayers: 16,
              roundSpeed: "1 MIN",
              entryFee: 10,
              status: "ACTIVE",
            },
          },
        ]),
        findUnique: jest.fn().mockResolvedValue({
          id: "ARENA_1",
          createdAt: new Date("2026-06-01T12:00:00.000Z"),
          rounds: [],
          pools: [],
        }),
      },
    };

    service = new ArenaQueryService(mockPrisma);
  });

  it("lists arenas and maps discovery metadata", async () => {
    const result = await service.listArenas({ limit: 10, filter: "active" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        id: "ARENA_1",
        number: "#0001",
        name: "Alpha Arena",
        playersJoined: 1,
        maxPlayers: 16,
        status: "ACTIVE",
      }),
    );
    expect(mockPrisma.arena.findMany).toHaveBeenCalled();
  });

  it("filters arenas by search query", async () => {
    const result = await service.listArenas({ search: "Alpha" });
    expect(result.items).toHaveLength(1);

    const noMatch = await service.listArenas({ search: "NonExistent" });
    expect(noMatch.items).toHaveLength(0);
  });

  it("fetches single arena by id and throws 404 when not found", async () => {
    const arena = await service.getArenaById("ARENA_1");
    expect(arena.id).toBe("ARENA_1");

    mockPrisma.arena.findUnique.mockResolvedValueOnce(null);
    await expect(service.getArenaById("MISSING")).rejects.toThrow("Arena with ID MISSING not found");
  });
});
