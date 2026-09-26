import { AsyncLocalStorage } from "async_hooks";
import {
  dbQueryBudgetViolationsTotal,
  dbQueryDurationSeconds,
  dbQueryCountPerRequest,
} from "../utils/metrics";
import { logger } from "../utils/logger";

export interface QueryRecord {
  datastore: "prisma" | "mongoose";
  fingerprint: string;
  durationMs: number;
  rowCount?: number | undefined;
  timestamp: number;
  isWrite: boolean;
}

export interface QueryBudgetConfig {
  maxQueries?: number | undefined;
  maxCumulativeTimeMs?: number | undefined;
  maxSingleQueryTimeMs?: number | undefined;
  mode?: "warn" | "shed" | undefined;
}

export interface QueryBudgetContext {
  correlationId: string;
  route: string;
  jobClass?: string | undefined;
  budget: QueryBudgetConfig;
  queries: QueryRecord[];
  hasSideEffects: boolean;
  isSafeRead: boolean;
  startTime: number;
}

export interface BudgetViolation {
  type: "query_count" | "cumulative_time" | "single_query_time";
  limit: number;
  actual: number;
  route: string;
  datastore?: string | undefined;
}

const queryStorage = new AsyncLocalStorage<QueryBudgetContext>();

/**
 * Normalizes query string/fingerprint by stripping literals, numbers, UUIDs,
 * wallet addresses (Stellar/Soroban G... / C...), and hex strings so sensitive
 * user parameters are never logged or stored in metrics.
 */
export function normalizeQueryFingerprint(raw: string): string {
  if (!raw || typeof raw !== "string") return "unknown_query";

  return raw
    // Replace Stellar public keys and Soroban contract IDs
    .replace(/[GC][A-Z2-7]{55}/g, "?")
    // Replace UUIDs
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "?")
    // Replace Hex strings / hashes
    .replace(/0x[0-9a-fA-F]+/g, "?")
    .replace(/\b[0-9a-fA-F]{32,64}\b/g, "?")
    // Replace quoted string literals
    .replace(/'(?:[^'\\]|\\.)*'/g, "?")
    .replace(/"(?:[^"\\]|\\.)*"/g, "?")
    // Replace numbers
    .replace(/\b\d+\b/g, "?")
    // Collapse IN (?) lists
    .replace(/\(\s*\?(?:\s*,\s*\?)*\s*\)/g, "(?)")
    // Collapse duplicate placeholders
    .replace(/(?:\?\s*,\s*)+\?/g, "?")
    // Normalize whitespace
    .replace(/\s+/g, " ")
    .trim();
}

export function getCurrentQueryContext(): QueryBudgetContext | undefined {
  return queryStorage.getStore();
}

export function runWithQueryBudget<T>(
  ctx: Partial<QueryBudgetContext>,
  fn: () => Promise<T>,
): Promise<T> {
  const fullCtx: QueryBudgetContext = {
    correlationId: ctx.correlationId ?? "unknown",
    route: ctx.route ?? "unknown",
    jobClass: ctx.jobClass,
    budget: ctx.budget ?? {
      maxQueries: 15,
      maxCumulativeTimeMs: 300,
      maxSingleQueryTimeMs: 150,
      mode: "warn",
    },
    queries: [],
    hasSideEffects: false,
    isSafeRead: ctx.isSafeRead ?? true,
    startTime: Date.now(),
  };

  return queryStorage.run(fullCtx, fn);
}

export function recordQueryExecution(params: {
  datastore: "prisma" | "mongoose";
  rawQueryOrModel: string;
  actionOrOp?: string;
  durationMs: number;
  rowCount?: number;
  isWrite?: boolean;
}): void {
  try {
    const ctx = queryStorage.getStore();
    const isWrite =
      params.isWrite ??
      (params.actionOrOp
        ? /^(create|update|delete|upsert|save|insert|remove|drop)/i.test(params.actionOrOp)
        : false);

    const rawStr = params.actionOrOp
      ? `${params.rawQueryOrModel}.${params.actionOrOp}`
      : params.rawQueryOrModel;

    const fingerprint = normalizeQueryFingerprint(rawStr);

    dbQueryDurationSeconds.observe(
      { datastore: params.datastore },
      params.durationMs / 1000,
    );

    if (ctx) {
      if (isWrite) {
        ctx.hasSideEffects = true;
      }

      ctx.queries.push({
        datastore: params.datastore,
        fingerprint,
        durationMs: params.durationMs,
        rowCount: params.rowCount,
        timestamp: Date.now(),
        isWrite,
      });

      // Check single query time budget violation immediately
      if (
        ctx.budget.maxSingleQueryTimeMs &&
        params.durationMs > ctx.budget.maxSingleQueryTimeMs
      ) {
        dbQueryBudgetViolationsTotal.inc({
          route: ctx.route,
          datastore: params.datastore,
          violation_type: "single_query_time",
        });
        logger.warn(
          {
            event: "db_slow_query_violation",
            correlationId: ctx.correlationId,
            route: ctx.route,
            datastore: params.datastore,
            durationMs: params.durationMs,
            limitMs: ctx.budget.maxSingleQueryTimeMs,
            fingerprint,
          },
          "Slow query exceeded single-query time budget",
        );
      }
    }
  } catch (err) {
    // Instrumentation failure must never break actual database operations
    logger.error({ err }, "Failed to record query budget instrumentation");
  }
}

export function evaluateBudgetViolations(
  ctx: QueryBudgetContext,
): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  const queryCount = ctx.queries.length;
  const cumulativeTimeMs = ctx.queries.reduce((acc, q) => acc + q.durationMs, 0);

  if (ctx.budget.maxQueries && queryCount > ctx.budget.maxQueries) {
    violations.push({
      type: "query_count",
      limit: ctx.budget.maxQueries,
      actual: queryCount,
      route: ctx.route,
    });
    dbQueryBudgetViolationsTotal.inc({
      route: ctx.route,
      datastore: "all",
      violation_type: "query_count",
    });
  }

  if (
    ctx.budget.maxCumulativeTimeMs &&
    cumulativeTimeMs > ctx.budget.maxCumulativeTimeMs
  ) {
    violations.push({
      type: "cumulative_time",
      limit: ctx.budget.maxCumulativeTimeMs,
      actual: cumulativeTimeMs,
      route: ctx.route,
    });
    dbQueryBudgetViolationsTotal.inc({
      route: ctx.route,
      datastore: "all",
      violation_type: "cumulative_time",
    });
  }

  dbQueryCountPerRequest.observe({ route: ctx.route }, queryCount);

  if (violations.length > 0) {
    // Collect top 3 slowest query fingerprints
    const topSlow = [...ctx.queries]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 3)
      .map((q) => ({
        fingerprint: q.fingerprint,
        durationMs: q.durationMs,
        datastore: q.datastore,
      }));

    logger.warn(
      {
        event: "db_query_budget_violation",
        correlationId: ctx.correlationId,
        route: ctx.route,
        jobClass: ctx.jobClass,
        queryCount,
        cumulativeTimeMs,
        violations,
        topSlow,
      },
      "Database query budget exceeded for request/job",
    );
  }

  return violations;
}
