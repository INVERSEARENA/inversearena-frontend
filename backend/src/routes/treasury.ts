/**
 * Treasury Reconciliation Routes (#1511)
 *
 * Read-only maintainer reporting over `TreasuryFeeRecord` — never triggers
 * ingestion or moves funds (see `treasuryReconciliationService.ts` and the
 * issue's explicit "out of scope" note). Mirrors `arenaReplay.ts`'s bounded
 * ledger-range + cursor pagination shape and `admin.ts`'s read-only-needs-
 * only-auth pattern (no confirmation token — this is non-destructive).
 */

import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { asyncHandler } from "../middleware/validate";
import { apiError } from "../utils/apiError";

const ReconciliationQuerySchema = z
  .object({
    arenaId: z.string().trim().min(1).max(200).optional(),
    status: z.enum(["pending", "balanced", "discrepant"]).optional(),
    discrepancyType: z
      .enum(["missing_transfer", "unexpected_transfer", "amount_mismatch", "destination_mismatch", "unfinalized_ledger"])
      .optional(),
    fromLedger: z.coerce.number().int().min(0).optional(),
    toLedger: z.coerce.number().int().min(0).optional(),
    fromDate: z.coerce.date().optional(),
    toDate: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
  })
  .refine((q) => q.fromLedger === undefined || q.toLedger === undefined || q.fromLedger <= q.toLedger, {
    message: "fromLedger must not be after toLedger",
    path: ["fromLedger"],
  })
  .refine((q) => q.fromDate === undefined || q.toDate === undefined || q.fromDate <= q.toDate, {
    message: "fromDate must not be after toDate",
    path: ["fromDate"],
  });

interface DecodedCursor {
  offset: number;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset } satisfies DecodedCursor)).toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as DecodedCursor;
    if (typeof payload.offset !== "number" || payload.offset < 0) return 0;
    return payload.offset;
  } catch {
    return 0;
  }
}

/** Fields returned to a maintainer — deliberately excludes nothing sensitive
 * (there is no secret/credential on this model), but is spelled out
 * explicitly rather than `select: undefined` so an accidental future field
 * addition to the model doesn't silently start round-tripping through this
 * response without a conscious decision. */
function serializeRecord(record: {
  id: string;
  network: string;
  recordType: string;
  arenaId: string;
  asset: string;
  assetIssuer: string | null;
  sourceTxHash: string;
  sourceEventId: string;
  sourceLedgerSequence: number;
  sourceLedgerClosedAt: Date;
  expectedAmountAtomic: bigint;
  configVersion: number;
  feeBpsApplied: number;
  destination: string | null;
  actualAmountAtomic: bigint | null;
  actualTxHash: string | null;
  actualDestination: string | null;
  status: string;
  discrepancyType: string | null;
  reconciledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: record.id,
    network: record.network,
    recordType: record.recordType,
    arenaId: record.arenaId,
    asset: record.asset,
    assetIssuer: record.assetIssuer,
    sourceTxHash: record.sourceTxHash,
    sourceEventId: record.sourceEventId,
    sourceLedgerSequence: record.sourceLedgerSequence,
    sourceLedgerClosedAt: record.sourceLedgerClosedAt.toISOString(),
    expectedAmountAtomic: record.expectedAmountAtomic.toString(),
    configVersion: record.configVersion,
    feeBpsApplied: record.feeBpsApplied,
    destination: record.destination,
    actualAmountAtomic: record.actualAmountAtomic?.toString() ?? null,
    actualTxHash: record.actualTxHash,
    actualDestination: record.actualDestination,
    status: record.status,
    discrepancyType: record.discrepancyType,
    reconciledAt: record.reconciledAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function createTreasuryRouter(adminAuthMiddleware: RequestHandler, prisma: PrismaClient): Router {
  const router = Router();

  /**
   * GET /api/admin/treasury/reconciliation
   *
   * Bounded by ledger range and/or date range, cursor-paginated. Admin-auth
   * only (read-only — matches `admin.ts`'s `/audit-logs` precedent, no
   * confirmation token).
   */
  router.get(
    "/treasury/reconciliation",
    adminAuthMiddleware,
    asyncHandler(async (req, res) => {
      const parsed = ReconciliationQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw apiError(400, "VALIDATION_ERROR", parsed.error.issues.map((i) => i.message).join("; "));
      }
      const query = parsed.data;
      const offset = query.cursor ? decodeCursor(query.cursor) : 0;

      const where: Record<string, unknown> = {};
      if (query.arenaId !== undefined) where.arenaId = query.arenaId;
      if (query.status !== undefined) where.status = query.status;
      if (query.discrepancyType !== undefined) where.discrepancyType = query.discrepancyType;
      if (query.fromLedger !== undefined || query.toLedger !== undefined) {
        where.sourceLedgerSequence = {
          ...(query.fromLedger !== undefined ? { gte: query.fromLedger } : {}),
          ...(query.toLedger !== undefined ? { lte: query.toLedger } : {}),
        };
      }
      if (query.fromDate !== undefined || query.toDate !== undefined) {
        where.sourceLedgerClosedAt = {
          ...(query.fromDate !== undefined ? { gte: query.fromDate } : {}),
          ...(query.toDate !== undefined ? { lte: query.toDate } : {}),
        };
      }

      const records = await prisma.treasuryFeeRecord.findMany({
        where,
        orderBy: [{ sourceLedgerSequence: "asc" }, { id: "asc" }],
        take: query.limit + 1,
        skip: offset,
      });

      const hasMore = records.length > query.limit;
      const items = records.slice(0, query.limit);

      res.json({
        items: items.map(serializeRecord),
        cursor: hasMore ? encodeCursor(offset + query.limit) : null,
        hasMore,
      });
    }),
  );

  return router;
}
