import { ArenaParticipantsService } from "../arenaParticipantsService";

describe("ArenaParticipantsService", () => {
  let mockPrisma: any;
  let service: ArenaParticipantsService;

  beforeEach(() => {
    mockPrisma = {
      arena: {
        findUnique: jest.fn().mockResolvedValue({
          id: "ARENA_1",
          createdAt: new Date("2026-06-01T12:00:00.000Z"),
          rounds: [
            {
              id: "ROUND_1",
              roundNumber: 1,
              state: "RESOLVED",
              createdAt: new Date("2026-06-01T12:00:00.000Z"),
              eliminationLogs: [],
              metadata: {
                playerChoices: [
                  { userId: "u-1", choice: "heads", stake: 10 },
                  { userId: "u-2", choice: "tails", stake: 10 },
                ],
              },
            },
          ],
        }),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([
          { id: "u-1", walletAddress: "G_WALLET_1" },
          { id: "u-2", walletAddress: "G_WALLET_2" },
        ]),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };

    service = new ArenaParticipantsService(mockPrisma);
  });

  it("returns participants in items array and resolves user identities (fixing items undefined bug)", async () => {
    const result = await service.getParticipants("ARENA_1", 20, 0);

    expect(result.arenaId).toBe("ARENA_1");
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        walletAddress: "G_WALLET_1",
        choice: "heads",
        stake: 10,
        status: "ACTIVE",
      }),
    );
  });

  it("hides player choice when round state is OPEN for fairness", async () => {
    mockPrisma.arena.findUnique.mockResolvedValueOnce({
      id: "ARENA_1",
      createdAt: new Date(),
      rounds: [
        {
          id: "ROUND_2",
          roundNumber: 2,
          state: "OPEN",
          createdAt: new Date(),
          eliminationLogs: [],
          metadata: {
            playerChoices: [{ userId: "u-1", choice: "heads", stake: 10 }],
          },
        },
      ],
    });

    const result = await service.getParticipants("ARENA_1", 20, 0);
    expect(result.items[0].choice).toBeNull();
    expect(result.items[0].status).toBe("READY");
  });
});
