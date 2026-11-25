import { WeeklyDigestService } from "../weeklyDigestService";

describe("WeeklyDigestService", () => {
  let mockPrisma: any;
  let mockPrefsService: any;
  let mockPushService: any;
  let service: WeeklyDigestService;

  const now = new Date("2026-06-08T12:00:00.000Z");
  const weekStart = new Date("2026-06-01T12:00:00.000Z");
  const weekEnd = now;

  beforeEach(() => {
    mockPrisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: "u-1",
          walletAddress: "G_USER_WALLET",
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      eliminationLog: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      transaction: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      arena: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      notificationDelivery: {
        create: jest.fn().mockResolvedValue({ id: "del-1" }),
      },
    };

    mockPrefsService = {
      getPreferences: jest.fn().mockResolvedValue({
        userId: "u-1",
        digestNotifications: true,
        pushEnabled: true,
      }),
    };

    mockPushService = {
      sendPushToUser: jest.fn().mockResolvedValue(true),
    };

    service = new WeeklyDigestService(
      mockPrisma,
      mockPrefsService,
      mockPushService,
    );
  });

  it("skips users with no activity and no unclaimed funds", async () => {
    const digest = await service.buildUserDigest("u-1", weekStart, weekEnd);
    expect(digest).toBeNull();
  });

  it("assembles complete digest when user has games, wins, and unclaimed payouts", async () => {
    mockPrisma.eliminationLog.findMany.mockResolvedValueOnce([
      { id: "e-1", roundNumber: 3 },
      { id: "e-2", roundNumber: 5 },
    ]);

    mockPrisma.transaction.findMany
      .mockResolvedValueOnce([
        // weekly transactions
        { id: "t-1", type: "PAYOUT", amount: 15.5 },
      ])
      .mockResolvedValueOnce([
        // pending unclaimed payouts
        {
          id: "t-2",
          arenaId: "ARENA_ALPHA",
          amount: 25.0,
          asset: "USDC",
          type: "PAYOUT",
          status: "CONFIRMED",
        },
      ]);

    const digest = await service.buildUserDigest("u-1", weekStart, weekEnd);

    expect(digest).not.toBeNull();
    expect(digest?.userId).toBe("u-1");
    expect(digest?.results.gamesPlayed).toBe(2);
    expect(digest?.results.gamesWon).toBe(1);
    expect(digest?.results.winRate).toBe(50);
    expect(digest?.results.netYieldEarned).toBe("15.50");

    expect(digest?.unclaimedFunds.count).toBe(1);
    expect(digest?.unclaimedFunds.items[0].arenaId).toBe("ARENA_ALPHA");
    expect(digest?.unclaimedFunds.totalStroops).toBe("250000000");
  });

  it("includes host summary section if user created arenas during the week", async () => {
    mockPrisma.eliminationLog.findMany.mockResolvedValueOnce([]);
    mockPrisma.transaction.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    mockPrisma.arena.findMany.mockResolvedValueOnce([
      { id: "a-1", maxPlayers: 16 },
      { id: "a-2", maxPlayers: 32 },
    ]);

    const digest = await service.buildUserDigest("u-1", weekStart, weekEnd);

    expect(digest).not.toBeNull();
    expect(digest?.hostSummary).toBeDefined();
    expect(digest?.hostSummary?.arenasHosted).toBe(2);
    expect(digest?.hostSummary?.totalParticipants).toBe(48);
  });

  it("honors opt-out when digestNotifications is false", async () => {
    mockPrefsService.getPreferences.mockResolvedValueOnce({
      userId: "u-1",
      digestNotifications: false,
    });

    const mockDigest: any = {
      userId: "u-1",
      period: { start: "2026-06-01", end: "2026-06-08" },
      results: { gamesPlayed: 5, gamesWon: 2 },
      unclaimedFunds: { count: 0 },
    };

    const delivered = await service.deliverDigest(mockDigest);
    expect(delivered).toBe(false);
    expect(mockPrisma.notificationDelivery.create).not.toHaveBeenCalled();
    expect(mockPushService.sendPushToUser).not.toHaveBeenCalled();
  });

  it("delivers in-app and sends push notification when opted in", async () => {
    const mockDigest: any = {
      userId: "u-1",
      period: { start: "2026-06-01", end: "2026-06-08" },
      results: { gamesPlayed: 5, gamesWon: 2 },
      unclaimedFunds: { count: 1 },
    };

    const delivered = await service.deliverDigest(mockDigest);
    expect(delivered).toBe(true);
    expect(mockPrisma.notificationDelivery.create).toHaveBeenCalled();
    expect(mockPushService.sendPushToUser).toHaveBeenCalledWith(
      "u-1",
      expect.objectContaining({
        title: "Your Weekly Arena Digest",
      }),
    );
  });
});
