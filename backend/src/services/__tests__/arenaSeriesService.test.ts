import {
  calculateNextRun,
  parseCronExpression,
  zonedDateTimeToUtc,
  ArenaSeriesService,
} from "../arenaSeriesService";

describe("ArenaSeriesService - Cadence & DST computation", () => {
  it("parses 5-field cron expression correctly", () => {
    const parsed = parseCronExpression("0 20 * * *");
    expect(parsed).toEqual({
      minute: 0,
      hour: 20,
      dayOfMonth: null,
      month: null,
      dayOfWeek: null,
    });
  });

  it("calculates next daily run at 8:00 PM UTC", () => {
    // 2026-06-01 10:00 UTC -> next 20:00 UTC should be same day 20:00
    const from = new Date("2026-06-01T10:00:00.000Z");
    const next = calculateNextRun("0 20 * * *", "UTC", from);

    expect(next.toISOString()).toBe("2026-06-01T20:00:00.000Z");
  });

  it("advances to next day if current time has passed the scheduled hour", () => {
    const from = new Date("2026-06-01T21:00:00.000Z");
    const next = calculateNextRun("0 20 * * *", "UTC", from);

    expect(next.toISOString()).toBe("2026-06-02T20:00:00.000Z");
  });

  describe("DST transitions in America/New_York (8:00 PM local time)", () => {
    // In America/New_York:
    // Standard Time (EST): UTC-5 -> 20:00 EST = 01:00 UTC (next day)
    // Daylight Saving Time (EDT): UTC-4 -> 20:00 EDT = 00:00 UTC (next day)

    it("computes 8:00 PM during Daylight Saving Time (summer / EDT: UTC-4)", () => {
      const from = new Date("2026-07-15T15:00:00.000Z");
      const next = calculateNextRun("0 20 * * *", "America/New_York", from);

      // 20:00 EDT on July 15 is July 16 00:00:00 UTC
      expect(next.toISOString()).toBe("2026-07-16T00:00:00.000Z");
    });

    it("computes 8:00 PM during Standard Time (winter / EST: UTC-5)", () => {
      const from = new Date("2026-01-15T15:00:00.000Z");
      const next = calculateNextRun("0 20 * * *", "America/New_York", from);

      // 20:00 EST on Jan 15 is Jan 16 01:00:00 UTC
      expect(next.toISOString()).toBe("2026-01-16T01:00:00.000Z");
    });

    it("accurately crosses Spring Forward transition (March)", () => {
      // In 2026, US Spring Forward is Sunday, March 8 (clocks move 2am -> 3am)
      // Before transition: March 7 20:00 EST -> March 8 01:00 UTC
      // After transition: March 9 20:00 EDT -> March 10 00:00 UTC
      const fromBefore = new Date("2026-03-07T12:00:00.000Z");
      const nextBefore = calculateNextRun("0 20 * * *", "America/New_York", fromBefore);
      expect(nextBefore.toISOString()).toBe("2026-03-08T01:00:00.000Z");

      const fromAfter = new Date("2026-03-09T12:00:00.000Z");
      const nextAfter = calculateNextRun("0 20 * * *", "America/New_York", fromAfter);
      expect(nextAfter.toISOString()).toBe("2026-03-10T00:00:00.000Z");
    });

    it("accurately crosses Fall Back transition (November)", () => {
      // In 2026, US Fall Back is Sunday, November 1 (clocks move 2am -> 1am)
      // Before transition: Oct 31 20:00 EDT -> Nov 1 00:00 UTC
      // After transition: Nov 2 20:00 EST -> Nov 3 01:00 UTC
      const fromBefore = new Date("2026-10-31T12:00:00.000Z");
      const nextBefore = calculateNextRun("0 20 * * *", "America/New_York", fromBefore);
      expect(nextBefore.toISOString()).toBe("2026-11-01T00:00:00.000Z");

      const fromAfter = new Date("2026-11-02T12:00:00.000Z");
      const nextAfter = calculateNextRun("0 20 * * *", "America/New_York", fromAfter);
      expect(nextAfter.toISOString()).toBe("2026-11-03T01:00:00.000Z");
    });
  });
});

describe("ArenaSeriesService - Operations & Lifecycle", () => {
  let mockPrisma: any;
  let service: ArenaSeriesService;

  beforeEach(() => {
    mockPrisma = {
      hostWhitelistApplication: {
        findFirst: jest.fn().mockResolvedValue({ id: "wl-1", status: "approved" }),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: "u-1", walletAddress: "HOST_WALLET" }),
      },
      arena: {
        count: jest.fn().mockResolvedValue(2),
      },
      creatorTemplate: {
        findFirst: jest.fn().mockResolvedValue({
          id: "tmpl-1",
          status: "active",
          payload: { capacity: 16, entryFee: 10 },
        }),
      },
      arenaSeries: {
        create: jest.fn().mockImplementation((args) => ({ id: "series-1", ...args.data })),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        update: jest.fn().mockImplementation((args) => ({ id: args.where.id, ...args.data })),
      },
      arenaSeriesInstance: {
        create: jest.fn().mockImplementation((args) => ({ id: "inst-1", ...args.data })),
        findFirst: jest.fn(),
        update: jest.fn().mockImplementation((args) => ({ id: args.where.id, ...args.data })),
      },
    };

    service = new ArenaSeriesService(mockPrisma);
  });

  it("creates a recurring series when host is whitelisted and template is active", async () => {
    const series = await service.createSeries("HOST_WALLET", {
      templateId: "tmpl-1",
      name: "Daily 8pm Championship",
      cadence: "0 20 * * *",
      timezone: "America/New_York",
    });

    expect(series.name).toBe("Daily 8pm Championship");
    expect(series.status).toBe("active");
    expect(series.nextScheduledAt).toBeDefined();
    expect(mockPrisma.arenaSeries.create).toHaveBeenCalled();
  });

  it("rejects series creation if template is archived", async () => {
    mockPrisma.creatorTemplate.findFirst.mockResolvedValueOnce({
      id: "tmpl-archived",
      status: "archived",
    });

    await expect(
      service.createSeries("HOST_WALLET", {
        templateId: "tmpl-archived",
        name: "Archived Series",
        cadence: "0 20 * * *",
      }),
    ).rejects.toThrow("Cannot schedule series from an archived template");
  });

  it("pauses and resumes an active series", async () => {
    mockPrisma.arenaSeries.findUnique.mockResolvedValueOnce({
      id: "series-1",
      creatorAddress: "HOST_WALLET",
      status: "active",
      cadence: "0 20 * * *",
      timezone: "UTC",
    });

    const paused = await service.pauseSeries("series-1", "HOST_WALLET");
    expect(paused.status).toBe("paused");

    mockPrisma.arenaSeries.findUnique.mockResolvedValueOnce({
      id: "series-1",
      creatorAddress: "HOST_WALLET",
      status: "paused",
      cadence: "0 20 * * *",
      timezone: "UTC",
    });

    const resumed = await service.resumeSeries("series-1", "HOST_WALLET");
    expect(resumed.status).toBe("active");
  });

  it("skips the next scheduled instance", async () => {
    const scheduledFor = new Date("2026-06-01T20:00:00.000Z");
    mockPrisma.arenaSeries.findUnique.mockResolvedValueOnce({
      id: "series-1",
      creatorAddress: "HOST_WALLET",
      status: "active",
      cadence: "0 20 * * *",
      timezone: "UTC",
      nextScheduledAt: scheduledFor,
    });

    const result = await service.skipNextInstance("series-1", "HOST_WALLET");
    expect(mockPrisma.arenaSeriesInstance.create).toHaveBeenCalledWith({
      data: {
        seriesId: "series-1",
        scheduledFor,
        status: "skipped",
      },
    });
    expect(result.nextScheduledAt).toBeDefined();
  });

  it("processes due series instances and creates pending sign requests", async () => {
    const dueTime = new Date("2026-06-01T20:00:00.000Z");
    mockPrisma.arenaSeries.findMany.mockResolvedValueOnce([
      {
        id: "series-1",
        creatorAddress: "HOST_WALLET",
        templateId: "tmpl-1",
        name: "Daily 8pm",
        cadence: "0 20 * * *",
        timezone: "UTC",
        status: "active",
        instancesCreated: 0,
        nextScheduledAt: dueTime,
        endCondition: null,
      },
    ]);

    const createdInstances = await service.processDueSeriesInstances(
      new Date("2026-06-01T20:01:00.000Z"),
    );

    expect(createdInstances).toHaveLength(1);
    expect(createdInstances[0].status).toBe("pending");
    expect(createdInstances[0].signRequestPayload).toBeDefined();
    expect(mockPrisma.arenaSeries.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "series-1" },
        data: expect.objectContaining({ instancesCreated: 1 }),
      }),
    );
  });
});
