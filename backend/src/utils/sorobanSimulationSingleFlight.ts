/**
 * Bounded single-flight coalescing for identical read-only Soroban simulations (#1499).
 */
import { createHash } from "crypto";
import { xdr } from "@stellar/stellar-sdk";
import {
  sorobanSimulationCacheEvictionsTotal,
  sorobanSimulationCoalescedWaitersTotal,
  sorobanSimulationHitsTotal,
  sorobanSimulationMissesTotal,
} from "./metrics";

export type SimulationCacheKeyParts = {
  network: string;
  ledgerSequence: number;
  contractId: string;
  functionName: string;
  args: xdr.ScVal[];
};

const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_TTL_MS = 5_000;
const NEGATIVE_TTL_MS = 1_000;

type CacheEntry = {
  value: unknown;
  expiresAt: number;
};

export class SorobanSimulationSingleFlight {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly negativeUntil = new Map<string, number>();

  constructor(options?: {
    maxEntries?: number;
    ttlMs?: number;
    negativeTtlMs?: number;
  }) {
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.negativeTtlMs = options?.negativeTtlMs ?? NEGATIVE_TTL_MS;
  }

  static buildKey(parts: SimulationCacheKeyParts): string {
    const argsDigest = createHash("sha256")
      .update(
        parts.args
          .map((arg) => arg.toXDR("base64"))
          .join("|"),
      )
      .digest("hex");
    return [
      parts.network,
      String(parts.ledgerSequence),
      parts.contractId,
      parts.functionName,
      argsDigest,
    ].join(":");
  }

  private evictIfNeeded(): void {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (!oldest) break;
      this.cache.delete(oldest);
      sorobanSimulationCacheEvictionsTotal.inc();
    }
  }

  async run<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const negativeUntil = this.negativeUntil.get(key);
    if (negativeUntil && negativeUntil > now) {
      sorobanSimulationMissesTotal.inc({ reason: "negative" });
      return fetcher();
    }

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      sorobanSimulationHitsTotal.inc();
      return cached.value as T;
    }
    if (cached) {
      this.cache.delete(key);
      sorobanSimulationCacheEvictionsTotal.inc();
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      sorobanSimulationCoalescedWaitersTotal.inc();
      return existing as Promise<T>;
    }

    sorobanSimulationMissesTotal.inc({ reason: "cold" });

    const promise = (async () => {
      try {
        const value = await fetcher();
        this.evictIfNeeded();
        this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        this.negativeUntil.delete(key);
        return value;
      } catch (error) {
        this.negativeUntil.set(key, Date.now() + this.negativeTtlMs);
        throw error;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise as Promise<T>;
  }

  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
    this.negativeUntil.clear();
  }
}

let defaultInstance: SorobanSimulationSingleFlight | null = new SorobanSimulationSingleFlight();

export function getSorobanSimulationSingleFlight(): SorobanSimulationSingleFlight {
  if (!defaultInstance) {
    defaultInstance = new SorobanSimulationSingleFlight();
  }
  return defaultInstance;
}

/** Test seam — bypass coalescing in unit tests. */
export function setSorobanSimulationSingleFlightForTest(
  instance: SorobanSimulationSingleFlight | null,
): void {
  defaultInstance = instance;
}
