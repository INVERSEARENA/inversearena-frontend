import { PrismaClient } from "@prisma/client";
import { getAssetMetadata } from "../types/asset";

/**
 * Per-arena yield time-series (#1568).
 *
 * Each point corresponds to one on-chain `resolve_round` as indexed in the
 * DB by `roundService.resolveRound` (the contract is resolved on-chain
 * first, then the outcome — including `oracleYield` and payout breakdowns —
 * is written to the round's metadata). Rounds without a payout (e.g. no
 * winner yet, or a decreased vault balance) still produce a point with
 * `accrued: "0"` so the series stays gap-free.
 *
 * Amounts are decimal strings in the arena's stake asset with exactly
 * `assetDecimals` fractional digits. `rateBps` is the round's applied yield
 * rate in basis points, derived from the stored `oracleYield` percent
 * (`percent * 100`); it is `null` when the round recorded no rate.
 */

export interface YieldPoint {
  round: number;
  /** ISO timestamp of the round's last update (resolution time). */
  timestamp: string;
  /** Round yield rate in basis points, as an integer string; null if unknown. */
  rateBps: string | null;
  /** Yield accrued in this round, decimal string in the stake asset. */
  accrued: string;
  /** Running total through this round, decimal string in the stake asset. */
  cumulative: string;
}

export interface YieldSeries {
  arenaId: string;
  asset: string;
  assetDecimals: number;
  points: YieldPoint[];
  nextCursor: string | null;
  hasMore: boolean;
  /** True when the arena has a SETTLED round — the series is immutable. */
  finished: boolean;
}

interface DecodedCursor {
  offset: number;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset } as DecodedCursor)).toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const payload = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf-8"),
    ) as DecodedCursor;
    if (typeof payload.offset !== "number" || payload.offset < 0) return 0;
    return payload.offset;
  } catch {
    return 0;
  }
}

/** Format atomic units as a decimal string with exactly `decimals` places. */
function formatAtomic(atomic: bigint, decimals: number): string {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

/**
 * Extract an atomic yield amount from a persisted payout `yieldAmount`.
 * Persisted metadata may hold a Money-shaped object (`{atomicAmount, asset}`)
 * or — from older writers — a plain number (display units) or numeric
 * string. Unknown shapes contribute 0 rather than failing the series.
 */
function parseYieldAtomic(value: unknown, decimals: number): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.round(value * 10 ** decimals));
  }
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) {
      try {
        return BigInt(value);
      } catch {
        return 0n;
      }
    }
    const asDisplay = Number(value);
    if (Number.isFinite(asDisplay)) {
      return BigInt(Math.round(asDisplay * 10 ** decimals));
    }
    return 0n;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const atomic = record.atomicAmount;
    if (typeof atomic === "string" || typeof atomic === "number") {
      try {
        const big = BigInt(atomic);
        // A plain small integer without asset context is ambiguous; prefer
        // the atomic interpretation only when an asset object is present or
        // the value is a digit string (the Money JSON shape).
        if (typeof atomic === "string" || "asset" in record) return big;
      } catch {
        // fall through to display interpretation below
      }
    }
    const display = Number(record.display ?? record.amount ?? record.value);
    if (Number.isFinite(display)) {
      return BigInt(Math.round(display * 10 ** decimals));
    }
  }
  return 0n;
}

export class ArenaYieldService {
  constructor(private prisma: PrismaClient) {}

  async getYieldSeries(
    arenaId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<YieldSeries> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = options.cursor ? decodeCursor(options.cursor) : 0;

    const arena = await this.prisma.arena.findUnique({ where: { id: arenaId } });
    if (!arena) {
      throw new Error(`Arena with ID ${arenaId} not found`);
    }
    const metadata = (arena.metadata as Record<string, unknown>) ?? {};
    const stakeToken =
      typeof metadata.stakeToken === "string" && metadata.stakeToken.length > 0
        ? metadata.stakeToken
        : "XLM";
    const assetDecimals = getAssetMetadata(stakeToken).decimals;

    // All resolved/settled rounds in order. The full ordered scan keeps
    // `cumulative` correct across pages; responses are cached (see route),
    // and per-point payloads are small (no player choices).
    const rounds = await this.prisma.round.findMany({
      where: { arenaId, state: { in: ["RESOLVED", "SETTLED"] } },
      orderBy: [{ roundNumber: "asc" }, { id: "asc" }],
      select: { roundNumber: true, metadata: true, updatedAt: true, state: true },
    });

    let running = 0n;
    const allPoints: YieldPoint[] = rounds.map((round) => {
      const roundMetadata = (round.metadata as Record<string, unknown>) ?? {};
      const oracleYield =
        typeof roundMetadata.oracleYield === "number" ? roundMetadata.oracleYield : null;
      const resolution = roundMetadata.resolution as
        | { payouts?: Array<{ yieldAmount?: unknown }> }
        | undefined;
      const payouts = Array.isArray(resolution?.payouts) ? resolution!.payouts! : [];
      const accruedAtomic = payouts.reduce(
        (sum, payout) => sum + parseYieldAtomic(payout?.yieldAmount, assetDecimals),
        0n,
      );
      running += accruedAtomic;
      return {
        round: round.roundNumber,
        timestamp: round.updatedAt.toISOString(),
        rateBps: oracleYield === null ? null : String(Math.round(oracleYield * 100)),
        accrued: formatAtomic(accruedAtomic, assetDecimals),
        cumulative: formatAtomic(running, assetDecimals),
      };
    });

    const finished = rounds.some((round) => round.state === "SETTLED");
    const page = allPoints.slice(offset, offset + limit);
    const hasMore = offset + limit < allPoints.length;

    return {
      arenaId,
      asset: stakeToken,
      assetDecimals,
      points: page,
      nextCursor: hasMore ? encodeCursor(offset + limit) : null,
      hasMore,
      finished,
    };
  }
}
