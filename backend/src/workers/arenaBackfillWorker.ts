import type { PrismaClient, Prisma } from "@prisma/client";
import {
  getFactoryArenaPage,
  FactoryReadError,
  type FactoryArenaMetadata,
} from "../services/onChainReader";
import {
  backfillRunsTotal,
  backfillArenasDiscoveredTotal,
  backfillArenasFailedTotal,
  backfillRunDurationSeconds,
  backfillCursorPosition,
} from "../utils/metrics";
import { logger } from "../utils/logger";

/** Job name used as the primary key of the single `BackfillCursor` row this
 * worker owns. Keying by job name (rather than a hard-coded singleton row)
 * lets a future second backfill-style job reuse the same table — see
 * docs/arena-discovery-backfill.md. */
export const ARENA_DISCOVERY_CURSOR_ID = "arena_discovery";

/** Page size passed to `get_arenas`; the contract itself clamps to 50
 * (`MAX_PAGE_SIZE`, `contract/factory/src/lib.rs`), so this just matches that
 * cap rather than relying on the clamp silently shrinking a larger request. */
const DEFAULT_PAGE_SIZE = 50;

/** Upper bound on pages read in a single `run()` call, so one invocation of
 * the (HTTP-triggered) worker cannot scan an unbounded number of pages and
 * hold an RPC connection / block the event loop indefinitely on a very large
 * backfill window. A backlog larger than this is simply picked up across
 * multiple scheduled runs — the persisted cursor makes that safe. */
const DEFAULT_MAX_PAGES_PER_RUN = 20;

/** Signature of `getFactoryArenaPage` (`onChainReader.ts`) — injectable so
 * unit tests can exercise the worker's own orchestration (cursor advancement,
 * upsert idempotency, error handling) against a stubbed reader without
 * needing a real/simulated Soroban RPC round trip. Defaults to the real
 * `getFactoryArenaPage` in production. */
export type FactoryArenaPageReader = (
  factoryContractId: string,
  offset: number,
  limit: number,
) => Promise<FactoryArenaMetadata[]>;

export interface ArenaBackfillWorkerOptions {
  pageSize?: number;
  maxPagesPerRun?: number;
  readPage?: FactoryArenaPageReader;
}

export interface ArenaBackfillRunResult {
  status: "success" | "failed";
  /** Arenas read from the factory and successfully upserted this run. */
  discovered: number;
  /** Arenas read from the factory whose upsert failed (retried next run). */
  failed: number;
  /** Cursor position (`lastProcessed`) at the end of this run. */
  cursor: number;
  pagesRead: number;
  durationMs: number;
  /** Present only when `status === "failed"`. */
  error?: string;
}

/**
 * Reconciles the backend's `Arena` table against the factory contract's
 * authoritative `get_arenas` state (#1391).
 *
 * Discovers arenas whose `POST /api/arenas` confirmation never landed (page
 * closed, network drop, client crash) by paging through `get_arenas` in
 * `pool_id` order starting from a persisted cursor (`BackfillCursor`,
 * `lastProcessed`), and upserting each arena by its on-chain contract address
 * (`Arena.id`) — the same natural key `ArenaService.confirmArenaDeployment`
 * already writes under, so this is safe to re-run and safe to race against
 * that primary confirm path. See docs/arena-discovery-backfill.md for the
 * full design rationale (cursor semantics, failure behavior, idempotency).
 *
 * Follows `PaymentWorker`'s shape: a plain class with a `processBatch()`-style
 * entry point (`run()`), no BullMQ/cron — triggered by an admin-gated HTTP
 * endpoint (`POST /api/worker/arena-backfill/run`) on an external schedule.
 */
export class ArenaBackfillWorker {
  private readonly pageSize: number;
  private readonly maxPagesPerRun: number;
  private readonly readPage: FactoryArenaPageReader;
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly factoryContractId: string,
    options: ArenaBackfillWorkerOptions = {},
  ) {
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.maxPagesPerRun = options.maxPagesPerRun ?? DEFAULT_MAX_PAGES_PER_RUN;
    this.readPage = options.readPage ?? getFactoryArenaPage;
  }

  /**
   * Runs one backfill pass: reads pages from the persisted cursor forward,
   * upserting each arena and advancing the cursor one arena at a time, until
   * either the factory has no more pools to report, `maxPagesPerRun` is hit,
   * or a page read fails outright.
   *
   * Concurrency guard mirrors `PaymentWorker.processBatch`: a run already in
   * progress causes a second concurrent call to return immediately rather
   * than double-paging the same cursor range.
   */
  async run(): Promise<ArenaBackfillRunResult> {
    if (this.isRunning) {
      logger.warn(
        "ArenaBackfillWorker.run: run already in progress, skipping concurrent execution",
      );
      const cursor = await this.loadCursor();
      return {
        status: "success",
        discovered: 0,
        failed: 0,
        cursor,
        pagesRead: 0,
        durationMs: 0,
      };
    }

    this.isRunning = true;
    const startedAt = Date.now();
    let discovered = 0;
    let failed = 0;
    let pagesRead = 0;

    try {
      let cursor = await this.loadCursor();
      const startCursor = cursor;

      for (; pagesRead < this.maxPagesPerRun; ) {
        let page: FactoryArenaMetadata[];
        try {
          page = await this.readPage(this.factoryContractId, cursor, this.pageSize);
          // Counted as soon as the page read succeeds, regardless of which
          // exit path (short page / empty page / loop continues) follows —
          // a page we successfully read counts toward pagesRead even if it
          // turns out to be the last one via `break`.
          pagesRead += 1;
        } catch (error) {
          // An RPC/network failure reading a page aborts the run without
          // advancing the cursor past that page — the next scheduled run
          // retries from the same position. This is deliberately NOT the
          // same code path as a per-arena upsert failure (below): a page
          // read failure means we never saw the data at all, so there is
          // nothing to log per-arena and nothing safe to skip past.
          const durationMs = Date.now() - startedAt;
          const reason = error instanceof FactoryReadError ? error.message : String(error);
          const pagesAttempted = pagesRead + 1;
          logger.error(
            { cursor, pageSize: this.pageSize, pagesRead: pagesAttempted, durationMs, err: error },
            "ArenaBackfillWorker.run: factory page read failed, aborting run",
          );
          backfillRunsTotal.inc({ status: "failed" });
          backfillRunDurationSeconds.observe(durationMs / 1000);
          backfillCursorPosition.set(cursor);
          return {
            status: "failed",
            discovered,
            failed,
            cursor,
            pagesRead: pagesAttempted,
            durationMs,
            error: reason,
          };
        }

        if (page.length === 0) {
          // Fewer than `pageSize` results (including zero) means we've
          // reached the end of the factory's current pool list.
          break;
        }

        for (const arena of page) {
          try {
            await this.upsertArena(arena);
            cursor = arena.poolId;
            await this.saveCursor(cursor);
            discovered += 1;
            backfillArenasDiscoveredTotal.inc();
          } catch (error) {
            // A single arena's upsert failing (malformed data, DB error) is
            // logged and counted, but does NOT advance the cursor past this
            // pool_id and does NOT abort the run — the next scheduled run
            // retries just this arena. No separate retry/backoff bookkeeping
            // is needed because the cursor already encodes "not yet done".
            failed += 1;
            backfillArenasFailedTotal.inc();
            logger.error(
              {
                poolId: arena.poolId,
                arenaAddress: arena.arenaAddress,
                err: error,
              },
              "ArenaBackfillWorker.run: arena upsert failed, will retry next run",
            );
          }
        }

        if (page.length < this.pageSize) {
          // Short page: no more pools beyond this one right now.
          break;
        }
      }

      const durationMs = Date.now() - startedAt;
      backfillRunsTotal.inc({ status: "success" });
      backfillRunDurationSeconds.observe(durationMs / 1000);
      backfillCursorPosition.set(cursor);
      logger.info(
        {
          startCursor,
          cursor,
          discovered,
          failed,
          pagesRead,
          durationMs,
        },
        "ArenaBackfillWorker.run: backfill pass complete",
      );

      return {
        status: "success",
        discovered,
        failed,
        cursor,
        pagesRead,
        durationMs,
      };
    } finally {
      this.isRunning = false;
    }
  }

  private async loadCursor(): Promise<number> {
    const row = await this.prisma.backfillCursor.findUnique({
      where: { id: ARENA_DISCOVERY_CURSOR_ID },
    });
    return row?.lastProcessed ?? 0;
  }

  private async saveCursor(lastProcessed: number): Promise<void> {
    await this.prisma.backfillCursor.upsert({
      where: { id: ARENA_DISCOVERY_CURSOR_ID },
      create: { id: ARENA_DISCOVERY_CURSOR_ID, lastProcessed },
      update: { lastProcessed },
    });
  }

  /**
   * Upserts one arena by its on-chain contract address (`Arena.id`) — the
   * same primary key `ArenaService.confirmArenaDeployment` writes under.
   *
   * The `update` clause is intentionally a no-op: if the row already exists
   * (created by the primary confirm path, or a previous backfill run), this
   * upsert must never clobber fields the richer confirm-path write already
   * set (e.g. `metadata.createdBy`, `metadata.deployment.txHash`). It only
   * ever fills in arenas the confirm path never reached. This is what makes
   * re-running the backfill, and racing it against the confirm path or
   * another concurrent backfill run, safe by construction — see
   * docs/arena-discovery-backfill.md#idempotency--concurrency.
   */
  private async upsertArena(arena: FactoryArenaMetadata): Promise<void> {
    const metadata: Prisma.InputJsonValue = JSON.parse(
      JSON.stringify({
        contractAddress: arena.arenaAddress,
        entryFee: arena.entryFee.toString(),
        host: arena.host,
        poolId: arena.poolId,
        factoryStatus: arena.status,
        deployment: {
          status: "backfilled",
          factoryContractId: this.factoryContractId,
        },
      }),
    ) as Prisma.InputJsonValue;

    await this.prisma.arena.upsert({
      where: { id: arena.arenaAddress },
      create: { id: arena.arenaAddress, metadata },
      update: {},
    });
  }
}
