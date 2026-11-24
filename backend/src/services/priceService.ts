/**
 * SEP-40-compatible fiat price service (#1858).
 *
 * Reads prices from an on-chain oracle contract, caches them with a staleness
 * flag, and exposes helpers for embedding fiat equivalents in API responses.
 *
 * The source interface is pluggable: the first implementation uses a Stellar
 * contract (configured by PRICE_ORACLE_CONTRACT_ID) that exposes `lastprice`
 * and `decimals` matching the SEP-40 / Reflector interface. Any other source
 * can be substituted by implementing PriceOracleSource.
 */

export interface PriceOracleSource {
  lastprice(assetCode: string): Promise<{ price: bigint; decimals: number; timestamp: number } | null>;
}

export interface CachedPrice {
  assetCode: string;
  priceUsd: number;
  decimals: number;
  computedAt: number;
  stale: boolean;
}

export interface PriceServiceOptions {
  ttlSeconds?: number;
  staleAfterSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_STALE_AFTER_SECONDS = 600;

export class PriceService {
  private cache = new Map<string, CachedPrice>();
  private readonly ttlSeconds: number;
  private readonly staleAfterSeconds: number;

  constructor(
    private readonly source: PriceOracleSource,
    options: PriceServiceOptions = {},
  ) {
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.staleAfterSeconds = options.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;
  }

  async getPrice(assetCode: string): Promise<CachedPrice | null> {
    const now = Math.floor(Date.now() / 1000);
    const cached = this.cache.get(assetCode);

    if (cached && now - cached.computedAt < this.ttlSeconds) {
      return cached;
    }

    try {
      const reading = await this.source.lastprice(assetCode);
      if (!reading) {
        if (cached) {
          return { ...cached, stale: now - cached.computedAt >= this.staleAfterSeconds };
        }
        return null;
      }

      const divisor = 10 ** reading.decimals;
      const priceUsd = Number(reading.price) / divisor;
      const entry: CachedPrice = {
        assetCode,
        priceUsd,
        decimals: reading.decimals,
        computedAt: reading.timestamp,
        stale: now - reading.timestamp >= this.staleAfterSeconds,
      };

      this.cache.set(assetCode, entry);
      return entry;
    } catch {
      if (cached) {
        return { ...cached, stale: true };
      }
      return null;
    }
  }

  /**
   * Convert a raw minor-unit token amount to its USD fiat equivalent.
   * Returns null when the price is unavailable or stale.
   */
  async toFiat(
    assetCode: string,
    rawAmount: bigint,
    tokenDecimals: number,
  ): Promise<{ usd: number; stale: boolean } | null> {
    const price = await this.getPrice(assetCode);
    if (!price || price.stale) return null;

    const divisor = 10n ** BigInt(tokenDecimals);
    const whole = Number(rawAmount / divisor);
    const fraction = Number(rawAmount % divisor) / 10 ** tokenDecimals;
    const usd = (whole + fraction) * price.priceUsd;

    return { usd, stale: price.stale };
  }

  invalidate(assetCode: string): void {
    this.cache.delete(assetCode);
  }

  invalidateAll(): void {
    this.cache.clear();
  }
}
