/**
 * Backfill script for Arena status and createdBy indexed columns (#1765).
 *
 * Promotes status and createdBy from JSON metadata to typed, indexed columns.
 * Can be run in dry-run mode or live with batched updates.
 */

import { PrismaClient } from "@prisma/client";
import { Command } from "commander";
import { logger } from "../utils/logger";

export interface ArenaBackfillOptions {
  dryRun?: boolean;
  batchSize?: number;
  limit?: number;
}

export interface ArenaBackfillSummary {
  status: "success" | "failed";
  scanned: number;
  updated: number;
  skipped: number;
  errors: number;
  durationMs: number;
  error?: string;
}

export class ArenaStatusAndCreatorBackfillService {
  constructor(private readonly prisma: PrismaClient) {}

  async run(options: ArenaBackfillOptions = {}): Promise<ArenaBackfillSummary> {
    const dryRun = options.dryRun ?? false;
    const batchSize = options.batchSize ?? 100;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;

    const startedAt = Date.now();
    let scanned = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    logger.info(
      { dryRun, batchSize, limit },
      "Starting arena status and createdBy column backfill (#1765)",
    );

    try {
      let cursor: string | undefined = undefined;
      let hasMore = true;

      while (hasMore && scanned < limit) {
        const take = Math.min(batchSize, limit - scanned);
        const arenas = await this.prisma.arena.findMany({
          take: take + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: { id: "asc" },
        });

        if (arenas.length === 0) {
          hasMore = false;
          break;
        }

        const page = arenas.slice(0, take);
        hasMore = arenas.length > take;
        if (page.length > 0) {
          cursor = page[page.length - 1].id;
        }

        for (const arena of page) {
          scanned += 1;
          try {
            const meta = (arena.metadata as Record<string, any>) || {};
            const metaStatus = typeof meta.status === "string" && meta.status.trim() ? meta.status.trim() : "ACTIVE";
            const metaCreatedBy = typeof meta.createdBy === "string" && meta.createdBy.trim() ? meta.createdBy.trim() : null;

            const needsStatusUpdate = arena.status !== metaStatus;
            const needsCreatorUpdate = arena.createdBy !== metaCreatedBy && metaCreatedBy !== null;

            if (!needsStatusUpdate && !needsCreatorUpdate) {
              skipped += 1;
              continue;
            }

            if (!dryRun) {
              await this.prisma.arena.update({
                where: { id: arena.id },
                data: {
                  status: metaStatus,
                  createdBy: metaCreatedBy ?? arena.createdBy,
                },
              });
            }

            updated += 1;
          } catch (err) {
            errors += 1;
            logger.error({ arenaId: arena.id, err }, "Failed to backfill arena row");
          }
        }
      }

      const durationMs = Date.now() - startedAt;
      logger.info(
        { scanned, updated, skipped, errors, durationMs },
        "Arena column backfill completed",
      );

      return {
        status: "success",
        scanned,
        updated,
        skipped,
        errors,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "Arena column backfill failed fatally");
      return {
        status: "failed",
        scanned,
        updated,
        skipped,
        errors,
        durationMs,
        error: errorMsg,
      };
    }
  }
}

/* istanbul ignore next */
async function main() {
  const program = new Command()
    .name("backfill-arena-fields")
    .description("Backfill arena status and createdBy columns from metadata")
    .option("--dry-run", "Execute without writing changes to the database", false)
    .option("--batch-size <number>", "Number of records per batch", (v) => parseInt(v, 10), 100)
    .option("--limit <number>", "Maximum total records to process", (v) => parseInt(v, 10))
    .parse(process.argv);

  const opts = program.opts();
  const prisma = new PrismaClient();
  const service = new ArenaStatusAndCreatorBackfillService(prisma);

  try {
    const summary = await service.run({
      dryRun: opts.dryRun,
      batchSize: opts.batchSize,
      limit: opts.limit,
    });
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.status === "success" ? 0 : 1);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal backfill error:", err);
    process.exit(1);
  });
}
