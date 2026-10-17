import { PrismaClient, Prisma } from "@prisma/client";
import { Command } from "commander";
import { logger } from "../utils/logger";
import { roundMetadataBackfillTotal } from "../utils/metrics";
import type { PlayerChoice, RoundMetadata, RoundResolution } from "../types/round";

export const ROUND_METADATA_NORMALIZATION_CURSOR_ID = "round_metadata_normalization";
const DEFAULT_BATCH_SIZE = 100;

export interface BackfillOptions {
  dryRun?: boolean | undefined;
  batchSize?: number | undefined;
  limit?: number | undefined;
}

export interface BackfillSummary {
  status: "success" | "failed";
  scanned: number;
  migrated: number;
  skipped: number;
  conflicting: number;
  errors: number;
  cursor: number;
  durationMs: number;
  error?: string | undefined;
}

export class RoundMetadataBackfillService {
  constructor(private readonly prisma: PrismaClient) {}

  async run(options: BackfillOptions = {}): Promise<BackfillSummary> {
    const dryRun = options.dryRun ?? false;
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;

    const startedAt = Date.now();
    let scanned = 0;
    let migrated = 0;
    let skipped = 0;
    let conflicting = 0;
    let errors = 0;

    logger.info(
      { dryRun, batchSize, limit },
      "Starting round metadata normalization backfill",
    );

    try {
      let cursor = await this.loadCursor();
      let hasMore = true;

      while (hasMore && scanned < limit) {
        const take = Math.min(batchSize, limit - scanned);
        const rounds = await this.prisma.round.findMany({
          orderBy: { createdAt: "asc" },
          skip: cursor,
          take,
        });

        if (rounds.length === 0) {
          hasMore = false;
          break;
        }

        for (const round of rounds) {
          scanned += 1;
          try {
            const rawMeta = round.metadata;
            if (!rawMeta || typeof rawMeta !== "object" || Array.isArray(rawMeta)) {
              skipped += 1;
              roundMetadataBackfillTotal.inc({ status: "skipped" });
              continue;
            }

            const parsed = this.parseAndValidateMetadata(round.id, rawMeta as Record<string, unknown>);
            if (!parsed.valid) {
              conflicting += 1;
              roundMetadataBackfillTotal.inc({ status: "conflicted" });
              logger.warn(
                { roundId: round.id, reasons: parsed.errors },
                "Round metadata normalization: conflicting or malformed metadata encountered",
              );
              continue;
            }

            // Check if row is already fully migrated
            const isAlreadyMigrated =
              round.oracleYield !== null &&
              round.playerChoices !== null;

            if (isAlreadyMigrated && !parsed.hasNewData) {
              skipped += 1;
              roundMetadataBackfillTotal.inc({ status: "skipped" });
              continue;
            }

            if (!dryRun) {
              await this.prisma.round.update({
                where: { id: round.id },
                data: {
                  oracleYield: parsed.data.oracleYield ?? null,
                  randomSeed: parsed.data.randomSeed ?? null,
                  playerChoices: parsed.data.playerChoices
                    ? (parsed.data.playerChoices as unknown as Prisma.InputJsonValue)
                    : Prisma.DbNull,
                  allActivePlayerIds: parsed.data.allActivePlayerIds ?? [],
                  resolution: parsed.data.resolution
                    ? (parsed.data.resolution as unknown as Prisma.InputJsonValue)
                    : Prisma.DbNull,
                  updatedAt: new Date(),
                },
              });
            }

            migrated += 1;
            roundMetadataBackfillTotal.inc({ status: "migrated" });
          } catch (err) {
            errors += 1;
            roundMetadataBackfillTotal.inc({ status: "error" });
            logger.error(
              { roundId: round.id, err },
              "Error migrating round metadata to typed columns",
            );
          }
        }

        cursor += rounds.length;
        if (!dryRun) {
          await this.saveCursor(cursor);
        }

        if (rounds.length < take) {
          hasMore = false;
        }
      }

      const durationMs = Date.now() - startedAt;
      const summary: BackfillSummary = {
        status: "success",
        scanned,
        migrated,
        skipped,
        conflicting,
        errors,
        cursor,
        durationMs,
      };

      logger.info(summary, "Round metadata normalization backfill finished");
      return summary;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, durationMs }, "Round metadata normalization backfill failed");
      return {
        status: "failed",
        scanned,
        migrated,
        skipped,
        conflicting,
        errors,
        cursor: 0,
        durationMs,
        error: errorMsg,
      };
    }
  }

  private parseAndValidateMetadata(
    roundId: string,
    meta: Record<string, unknown>,
  ): { valid: boolean; errors: string[]; hasNewData: boolean; data: Partial<RoundMetadata> } {
    const errors: string[] = [];
    const data: Partial<RoundMetadata> = {};
    let hasNewData = false;

    if (meta.oracleYield !== undefined && meta.oracleYield !== null) {
      if (typeof meta.oracleYield === "number" && !isNaN(meta.oracleYield)) {
        data.oracleYield = meta.oracleYield;
        hasNewData = true;
      } else {
        errors.push(`Invalid oracleYield type: expected number, got ${typeof meta.oracleYield}`);
      }
    }

    if (meta.randomSeed !== undefined && meta.randomSeed !== null) {
      if (typeof meta.randomSeed === "string") {
        data.randomSeed = meta.randomSeed;
        hasNewData = true;
      } else {
        errors.push(`Invalid randomSeed type: expected string, got ${typeof meta.randomSeed}`);
      }
    }

    if (meta.playerChoices !== undefined && meta.playerChoices !== null) {
      if (Array.isArray(meta.playerChoices)) {
        data.playerChoices = meta.playerChoices as PlayerChoice[];
        hasNewData = true;
      } else {
        errors.push(`Invalid playerChoices type: expected array, got ${typeof meta.playerChoices}`);
      }
    }

    if (meta.allActivePlayerIds !== undefined && meta.allActivePlayerIds !== null) {
      if (Array.isArray(meta.allActivePlayerIds) && meta.allActivePlayerIds.every((id) => typeof id === "string")) {
        data.allActivePlayerIds = meta.allActivePlayerIds as string[];
        hasNewData = true;
      } else {
        errors.push(`Invalid allActivePlayerIds: expected string array`);
      }
    }

    if (meta.resolution !== undefined && meta.resolution !== null) {
      if (typeof meta.resolution === "object" && !Array.isArray(meta.resolution)) {
        data.resolution = meta.resolution as RoundResolution;
        hasNewData = true;
      } else {
        errors.push(`Invalid resolution: expected object`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      hasNewData,
      data,
    };
  }

  private async loadCursor(): Promise<number> {
    const row = await this.prisma.backfillCursor.findUnique({
      where: { id: ROUND_METADATA_NORMALIZATION_CURSOR_ID },
    });
    return row?.lastProcessed ?? 0;
  }

  private async saveCursor(lastProcessed: number): Promise<void> {
    await this.prisma.backfillCursor.upsert({
      where: { id: ROUND_METADATA_NORMALIZATION_CURSOR_ID },
      create: { id: ROUND_METADATA_NORMALIZATION_CURSOR_ID, lastProcessed },
      update: { lastProcessed },
    });
  }
}

if (require.main === module) {
  const program = new Command();
  program
    .name("backfill-round-metadata")
    .description("Backfill round metadata from legacy JSON to typed columns")
    .option("--dry-run", "Simulate migration without modifying database records", false)
    .option("-b, --batch-size <number>", "Number of records per batch", "100")
    .option("-l, --limit <number>", "Maximum total records to process", "Infinity")
    .action(async (opts) => {
      const prisma = new PrismaClient();
      const service = new RoundMetadataBackfillService(prisma);
      try {
        const summary = await service.run({
          dryRun: Boolean(opts.dryRun),
          batchSize: parseInt(opts.batchSize, 10),
          limit: opts.limit === "Infinity" ? Number.POSITIVE_INFINITY : parseInt(opts.limit, 10),
        });
        console.log(JSON.stringify(summary, null, 2));
      } finally {
        await prisma.$disconnect();
      }
    });

  program.parse(process.argv);
}
