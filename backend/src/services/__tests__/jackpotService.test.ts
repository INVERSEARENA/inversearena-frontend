import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { jackpotService } from "../jackpotService";
import { prisma } from "../../db/prisma";

vi.mock("../../db/prisma");

describe("JackpotService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should get jackpot by token", async () => {
    const mockJackpot = {
      id: "1",
      stakeToken: "USDC",
      balanceAtomic: BigInt(1000),
      shareBps: 500,
      awardRule: "PERFECT_STREAK",
      awardThreshold: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    (prisma.jackpot.findUnique as any).mockResolvedValue(mockJackpot);

    const result = await jackpotService.getJackpotByToken("USDC");
    expect(result).toEqual(mockJackpot);
  });

  it("should create or get jackpot", async () => {
    const mockJackpot = {
      id: "1",
      stakeToken: "USDC",
      balanceAtomic: BigInt(0),
      shareBps: 500,
      awardRule: "PERFECT_STREAK",
      awardThreshold: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    (prisma.jackpot.upsert as any).mockResolvedValue(mockJackpot);

    const result = await jackpotService.createOrGetJackpot("USDC");
    expect(result.stakeToken).toBe("USDC");
  });

  it("should record award", async () => {
    const mockAward = {
      id: "award1",
      jackpotId: "jackpot1",
      arenaId: "arena1",
      winnerId: "user1",
      amountAtomic: BigInt(5000),
      awardReason: "PERFECT_STREAK",
      txHash: null,
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    (prisma.jackpotAward.create as any).mockResolvedValue(mockAward);
    (prisma.jackpot.update as any).mockResolvedValue({});

    const result = await jackpotService.recordAward(
      "jackpot1",
      "arena1",
      "user1",
      BigInt(5000),
      "PERFECT_STREAK",
    );

    expect(result.status).toBe("pending");
    expect(result.awardReason).toBe("PERFECT_STREAK");
  });

  it("should get jackpot history", async () => {
    const mockAwards = [
      {
        id: "award1",
        jackpotId: "jackpot1",
        arenaId: "arena1",
        winnerId: "user1",
        amountAtomic: BigInt(5000),
        awardReason: "PERFECT_STREAK",
        txHash: null,
        status: "paid",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    (prisma.jackpot.findUnique as any).mockResolvedValue({ id: "jackpot1" });
    (prisma.jackpotAward.findMany as any).mockResolvedValue(mockAwards);

    const result = await jackpotService.getJackpotHistory("USDC");
    expect(result).toHaveLength(1);
  });
});
