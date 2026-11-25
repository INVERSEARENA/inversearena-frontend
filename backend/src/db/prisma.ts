import { PrismaClient } from '@prisma/client';
import { recordQueryExecution } from './queryBudget';

export const prisma = new PrismaClient();

// #1525: Request-level database query instrumentation and budgeting
prisma.$use(async (params, next) => {
  const started = process.hrtime.bigint();
  try {
    const result = await next(params);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    recordQueryExecution({
      datastore: "prisma",
      rawQueryOrModel: params.model ?? "raw",
      actionOrOp: params.action,
      durationMs: elapsedMs,
      rowCount: Array.isArray(result) ? result.length : result ? 1 : 0,
    });
    return result;
  } catch (err) {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    recordQueryExecution({
      datastore: "prisma",
      rawQueryOrModel: params.model ?? "raw",
      actionOrOp: params.action,
      durationMs: elapsedMs,
    });
    throw err;
  }
});
