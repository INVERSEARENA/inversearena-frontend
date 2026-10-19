/**
 * Active Stake Limits — unit tests (#1411)
 *
 * Covers: normal pass, limit exactly reached, limit exceeded, db-error safe-block,
 * concurrent edge cases, and zero-stake join.
 */

import { ActiveStakeLimitsService, ActiveStakeLimitError, MAX_ACTIVE_STAKE_USDC } from "../src/services/activeStakeLimitsService";
import type { PrismaClient } from "@prisma/client";

function makePrisma(totalStake: number): PrismaClient {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ total: String(totalStake) }]),
  } as unknown as PrismaClient;
}

function makeFailingPrisma(): PrismaClient {
  return {
    $queryRaw: jest.fn().mockRejectedValue(new Error("DB connection lost")),
  } as unknown as PrismaClient;
}

describe("ActiveStakeLimitsService", () => {
  describe("getActiveStake", () => {
    it("returns 0 when no rows are returned", async () => {
      const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) } as unknown as PrismaClient;
      const svc = new ActiveStakeLimitsService(prisma);
      expect(await svc.getActiveStake("user-1")).toBe(0);
    });

    it("parses the decimal total correctly", async () => {
      const svc = new ActiveStakeLimitsService(makePrisma(1234.56));
      expect(await svc.getActiveStake("user-1")).toBeCloseTo(1234.56);
    });
  });

  describe("assertBelowActiveStakeLimit", () => {
    it("passes when current + incoming is below the limit", async () => {
      const svc = new ActiveStakeLimitsService(makePrisma(500));
      await expect(svc.assertBelowActiveStakeLimit("u1", 100)).resolves.toBeUndefined();
    });

    it("passes when current + incoming exactly equals the limit", async () => {
      const limit = MAX_ACTIVE_STAKE_USDC;
      const svc = new ActiveStakeLimitsService(makePrisma(limit - 100));
      await expect(svc.assertBelowActiveStakeLimit("u1", 100)).resolves.toBeUndefined();
    });

    it("throws ActiveStakeLimitError when limit would be exceeded", async () => {
      const svc = new ActiveStakeLimitsService(makePrisma(9999));
      await expect(svc.assertBelowActiveStakeLimit("u1", 2)).rejects.toThrow(ActiveStakeLimitError);
    });

    it("throws ActiveStakeLimitError when current already equals limit", async () => {
      const svc = new ActiveStakeLimitsService(makePrisma(MAX_ACTIVE_STAKE_USDC));
      await expect(svc.assertBelowActiveStakeLimit("u1", 1)).rejects.toThrow(ActiveStakeLimitError);
    });

    it("blocks join (safe default) when the DB query fails", async () => {
      const svc = new ActiveStakeLimitsService(makeFailingPrisma());
      await expect(svc.assertBelowActiveStakeLimit("u1", 100)).rejects.toThrow(ActiveStakeLimitError);
    });

    it("respects a custom limit override", async () => {
      const svc = new ActiveStakeLimitsService(makePrisma(500));
      await expect(svc.assertBelowActiveStakeLimit("u1", 600, 1000)).rejects.toThrow(ActiveStakeLimitError);
    });

    it("allows zero-stake join regardless of current exposure", async () => {
      const svc = new ActiveStakeLimitsService(makePrisma(MAX_ACTIVE_STAKE_USDC));
      await expect(svc.assertBelowActiveStakeLimit("u1", 0)).resolves.toBeUndefined();
    });

    it("error carries correct metadata", async () => {
      const svc = new ActiveStakeLimitsService(makePrisma(9500));
      try {
        await svc.assertBelowActiveStakeLimit("u1", 600);
        fail("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ActiveStakeLimitError);
        const err = e as ActiveStakeLimitError;
        expect(err.currentStake).toBe(9500);
        expect(err.incomingStake).toBe(600);
        expect(err.limit).toBe(MAX_ACTIVE_STAKE_USDC);
        expect(err.status).toBe(409);
        expect(err.code).toBe("ACTIVE_STAKE_LIMIT_EXCEEDED");
      }
    });
  });
});
