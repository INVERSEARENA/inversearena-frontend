/**
 * Fee Sponsorship Service — unit tests (#1413)
 *
 * Covers: issue, idempotent re-issue, consume, double-consume rejection,
 * expired token rejection, not-found rejection, and winner listing.
 */

import { FeeSponsorshipService, EligibilityConsumedError, EligibilityExpiredError, EligibilityNotFoundError } from "../src/services/feeSponsorshipService";

// Stub out metrics to avoid Prometheus registry conflicts in tests.
jest.mock("../src/utils/metrics", () => ({
  feeEligibilityIssuedTotal: { inc: jest.fn() },
  feeEligibilityConsumedTotal: { inc: jest.fn() },
  feeEligibilityExpiredTotal: { inc: jest.fn() },
  // Other metrics used elsewhere
  aliasUpdateTotal: { inc: jest.fn() },
  activeStakeLimitBlockedTotal: { inc: jest.fn() },
  activeStakeCurrentGauge: { set: jest.fn() },
  arenaHealthGauge: { set: jest.fn() },
  arenaChainLagGauge: { set: jest.fn() },
  arenaQueueLagGauge: { set: jest.fn() },
  arenaStateDriftGauge: { set: jest.fn() },
}));

describe("FeeSponsorshipService", () => {
  let svc: FeeSponsorshipService;

  beforeEach(() => {
    svc = new FeeSponsorshipService();
    svc._resetForTest();
  });

  describe("issueEligibility", () => {
    it("returns a PENDING token", () => {
      const token = svc.issueEligibility("payout-1", "winner-1");
      expect(token.status).toBe("PENDING");
      expect(token.payoutId).toBe("payout-1");
      expect(token.winnerId).toBe("winner-1");
      expect(token.tokenId).toBeTruthy();
    });

    it("is idempotent — returns the same token on duplicate issue", () => {
      const t1 = svc.issueEligibility("payout-1", "winner-1");
      const t2 = svc.issueEligibility("payout-1", "winner-1");
      expect(t1.tokenId).toBe(t2.tokenId);
    });

    it("sets expiresAt in the future", () => {
      const token = svc.issueEligibility("payout-2", "winner-2");
      expect(new Date(token.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe("consumeEligibility", () => {
    it("transitions status to CONSUMED", () => {
      const { tokenId } = svc.issueEligibility("payout-3", "winner-3");
      const consumed = svc.consumeEligibility(tokenId);
      expect(consumed.status).toBe("CONSUMED");
      expect(consumed.consumedAt).toBeTruthy();
    });

    it("throws EligibilityConsumedError on second consume", () => {
      const { tokenId } = svc.issueEligibility("payout-4", "winner-4");
      svc.consumeEligibility(tokenId);
      expect(() => svc.consumeEligibility(tokenId)).toThrow(EligibilityConsumedError);
    });

    it("throws EligibilityNotFoundError for unknown tokenId", () => {
      expect(() => svc.consumeEligibility("nonexistent-token")).toThrow(EligibilityNotFoundError);
    });

    it("throws EligibilityExpiredError for an expired token", () => {
      const token = svc.issueEligibility("payout-5", "winner-5");
      // Manually expire the token by monkey-patching the store via getEligibility
      // We test expiry by reaching into the internal store via a backdoor method.
      // The service exposes _resetForTest but not individual records, so we
      // check that the lazy expiry path fires when expiresAt is in the past by
      // reissuing with a mock date override.

      // Simulate expiry: get the token, rebuild it with a past expiresAt.
      const internalToken = svc.getEligibility(token.tokenId)!;
      // Replace in store via a new instance that shares the same tokenStore
      // map reference — this is a white-box test for the expiry branch.
      // Because the store is module-level we access it through the service.
      const pastDate = new Date(Date.now() - 1000).toISOString();
      Object.assign(internalToken, { expiresAt: pastDate });

      expect(() => svc.consumeEligibility(token.tokenId)).toThrow(EligibilityExpiredError);
    });
  });

  describe("getEligibility", () => {
    it("returns null for unknown tokenId", () => {
      expect(svc.getEligibility("no-such-id")).toBeNull();
    });

    it("returns the token by id", () => {
      const { tokenId } = svc.issueEligibility("payout-6", "winner-6");
      const found = svc.getEligibility(tokenId);
      expect(found?.tokenId).toBe(tokenId);
    });
  });

  describe("listPendingForWinner", () => {
    it("returns only PENDING tokens for the specified winner", () => {
      svc.issueEligibility("payout-7", "winner-7");
      svc.issueEligibility("payout-8", "winner-7");
      svc.issueEligibility("payout-9", "winner-other");

      const tokens = svc.listPendingForWinner("winner-7");
      expect(tokens).toHaveLength(2);
      expect(tokens.every((t) => t.winnerId === "winner-7")).toBe(true);
    });

    it("excludes consumed tokens", () => {
      const { tokenId } = svc.issueEligibility("payout-10", "winner-8");
      svc.consumeEligibility(tokenId);

      const tokens = svc.listPendingForWinner("winner-8");
      expect(tokens).toHaveLength(0);
    });

    it("returns empty array when winner has no tokens", () => {
      expect(svc.listPendingForWinner("nonexistent-winner")).toHaveLength(0);
    });
  });
});
