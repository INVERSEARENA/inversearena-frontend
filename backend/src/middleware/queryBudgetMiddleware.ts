import type { Request, Response, NextFunction } from "express";
import {
  runWithQueryBudget,
  evaluateBudgetViolations,
  getCurrentQueryContext,
  type QueryBudgetConfig,
} from "../db/queryBudget";

/** Route-specific budget configurations. */
const ROUTE_BUDGETS: Record<string, QueryBudgetConfig> = {
  "/api/dashboard": {
    maxQueries: 35,
    maxCumulativeTimeMs: 800,
    maxSingleQueryTimeMs: 300,
    mode: "warn",
  },
  "/api/leaderboard": {
    maxQueries: 25,
    maxCumulativeTimeMs: 500,
    maxSingleQueryTimeMs: 200,
    mode: "warn",
  },
  "/api/arenas": {
    maxQueries: 20,
    maxCumulativeTimeMs: 400,
    maxSingleQueryTimeMs: 200,
    mode: "warn",
  },
  "/api/arena-replay": {
    maxQueries: 30,
    maxCumulativeTimeMs: 600,
    maxSingleQueryTimeMs: 250,
    mode: "warn",
  },
};

const DEFAULT_BUDGET: QueryBudgetConfig = {
  maxQueries: 15,
  maxCumulativeTimeMs: 300,
  maxSingleQueryTimeMs: 150,
  mode: "warn",
};

export function getBudgetForRoute(path: string): QueryBudgetConfig {
  for (const [routePattern, config] of Object.entries(ROUTE_BUDGETS)) {
    if (path.startsWith(routePattern)) {
      return config;
    }
  }
  return DEFAULT_BUDGET;
}

export function queryBudgetMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const correlationId =
    (req.headers["x-request-id"] as string) ||
    (req as any).id ||
    `req-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  const isSafeRead = req.method === "GET" || req.method === "HEAD";
  const budget = getBudgetForRoute(req.path);

  void runWithQueryBudget(
    {
      correlationId,
      route: req.baseUrl ? `${req.baseUrl}${req.path}` : req.path,
      budget,
      isSafeRead,
    },
    async () => {
      // Intercept response finish/close to set headers and check violations
      const originalEnd = res.end;

      res.end = function (...args: any[]): Response {
        const ctx = getCurrentQueryContext();
        if (ctx) {
          const count = ctx.queries.length;
          const totalMs = ctx.queries.reduce((acc, q) => acc + q.durationMs, 0);

          if (!res.headersSent) {
            res.setHeader("X-Query-Count", count.toString());
            res.setHeader("X-Query-Time-Ms", totalMs.toFixed(2));
          }

          evaluateBudgetViolations(ctx);
        }

        return (originalEnd as any).apply(res, args);
      } as any;

      next();
    },
  );
}
