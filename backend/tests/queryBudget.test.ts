import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  normalizeQueryFingerprint,
  runWithQueryBudget,
  recordQueryExecution,
  getCurrentQueryContext,
  evaluateBudgetViolations,
} from "../src/db/queryBudget";
import {
  dbQueryBudgetViolationsTotal,
  dbQueryDurationSeconds,
  dbQueryCountPerRequest,
} from "../src/utils/metrics";

describe("Database Query Budgets & Slow-Query Attribution (#1525)", () => {
  describe("Fingerprint Normalization", () => {
    it("strips Stellar public keys and Soroban contract IDs", () => {
      const query = "SELECT * FROM users WHERE wallet_address = 'GBEXAMPLE7VK45Z27EXAMPLE7VK45Z27EXAMPLE7VK45Z27EXAMPL'";
      const normalized = normalizeQueryFingerprint(query);
      expect(normalized).not.toContain("GBEXAMPLE");
      expect(normalized).toBe("SELECT * FROM users WHERE wallet_address = ?");
    });

    it("strips UUIDs, hex values, strings, and numeric literals", () => {
      const query = "SELECT * FROM rounds WHERE id = '550e8400-e29b-41d4-a716-446655440000' AND round_number = 42 AND tx_hash = 0xabcdef123456";
      const normalized = normalizeQueryFingerprint(query);
      expect(normalized).not.toContain("550e8400");
      expect(normalized).not.toContain("42");
      expect(normalized).not.toContain("abcdef123456");
      expect(normalized).toBe("SELECT * FROM rounds WHERE id = ? AND round_number = ? AND tx_hash = ?");
    });

    it("collapses IN-lists to generic IN (?)", () => {
      const query = "SELECT * FROM users WHERE id IN ('id1', 'id2', 'id3', 'id4')";
      const normalized = normalizeQueryFingerprint(query);
      expect(normalized).toBe("SELECT * FROM users WHERE id IN (?)");
    });
  });

  describe("Context Attribution & Recording", () => {
    it("records queries into current AsyncLocalStorage context", async () => {
      await runWithQueryBudget(
        {
          correlationId: "req-test-123",
          route: "/api/arenas",
          budget: { maxQueries: 5, maxCumulativeTimeMs: 100 },
        },
        async () => {
          recordQueryExecution({
            datastore: "prisma",
            rawQueryOrModel: "Round.findUnique",
            actionOrOp: "findUnique",
            durationMs: 15.5,
            rowCount: 1,
          });

          recordQueryExecution({
            datastore: "mongoose",
            rawQueryOrModel: "Transaction",
            actionOrOp: "find",
            durationMs: 25.0,
            rowCount: 3,
          });

          const ctx = getCurrentQueryContext();
          expect(ctx).toBeDefined();
          expect(ctx?.correlationId).toBe("req-test-123");
          expect(ctx?.queries).toHaveLength(2);
          expect(ctx?.queries[0]?.datastore).toBe("prisma");
          expect(ctx?.queries[1]?.datastore).toBe("mongoose");
          expect(ctx?.hasSideEffects).toBe(false);
        },
      );
    });

    it("detects write side effects correctly", async () => {
      await runWithQueryBudget(
        {
          correlationId: "job-payout-1",
          jobClass: "PaymentWorker",
          isSafeRead: false,
        },
        async () => {
          recordQueryExecution({
            datastore: "prisma",
            rawQueryOrModel: "Round.update",
            actionOrOp: "update",
            durationMs: 10,
            isWrite: true,
          });

          const ctx = getCurrentQueryContext();
          expect(ctx?.hasSideEffects).toBe(true);
        },
      );
    });
  });

  describe("Budget Violation Detection", () => {
    it("detects and records query count violations", async () => {
      await runWithQueryBudget(
        {
          correlationId: "req-count-violation",
          route: "/api/leaderboard",
          budget: { maxQueries: 2, maxCumulativeTimeMs: 500 },
        },
        async () => {
          for (let i = 0; i < 4; i++) {
            recordQueryExecution({
              datastore: "prisma",
              rawQueryOrModel: "User.findMany",
              actionOrOp: "findMany",
              durationMs: 5,
            });
          }

          const ctx = getCurrentQueryContext()!;
          const violations = evaluateBudgetViolations(ctx);

          expect(violations).toHaveLength(1);
          expect(violations[0]?.type).toBe("query_count");
          expect(violations[0]?.actual).toBe(4);
          expect(violations[0]?.limit).toBe(2);
        },
      );
    });

    it("detects cumulative time violations", async () => {
      await runWithQueryBudget(
        {
          correlationId: "req-time-violation",
          route: "/api/dashboard",
          budget: { maxQueries: 10, maxCumulativeTimeMs: 50 },
        },
        async () => {
          recordQueryExecution({
            datastore: "prisma",
            rawQueryOrModel: "Arena.findMany",
            actionOrOp: "findMany",
            durationMs: 65,
          });

          const ctx = getCurrentQueryContext()!;
          const violations = evaluateBudgetViolations(ctx);

          expect(violations).toHaveLength(1);
          expect(violations[0]?.type).toBe("cumulative_time");
          expect(violations[0]?.actual).toBe(65);
        },
      );
    });
  });

  describe("Instrumentation Resilience", () => {
    it("does not throw or break if query context is absent (e.g. uninstrumented background tasks)", () => {
      expect(() => {
        recordQueryExecution({
          datastore: "prisma",
          rawQueryOrModel: "HealthCheck",
          actionOrOp: "query",
          durationMs: 2,
        });
      }).not.toThrow();
    });
  });
});
