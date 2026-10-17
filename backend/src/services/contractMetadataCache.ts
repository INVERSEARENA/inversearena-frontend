import { createHash } from "crypto";
import {
  contractMetadataCacheHitsTotal,
  contractMetadataCacheMissesTotal,
  contractMetadataCacheInvalidationsTotal,
  contractMetadataLookupDuration,
} from "../utils/metrics";
import { logger } from "../utils/logger";

export type MetadataClass = "immutable" | "version_scoped" | "mutable";

export type InvalidationReason =
  | "upgrade_detected"
  | "manual_purge"
  | "corrupted_entry"
  | "ttl_expired"
  | "rollback";

/**
 * Registry classifying contract fields.
 * Only immutable and version_scoped fields are allowed into this cache.
 * Mutable fields (balances, rounds, dynamic status) must NEVER be cached here.
 */
export const FIELD_CLASSIFICATION_REGISTRY: Record<string, MetadataClass> = {
  // Immutable (never change for the life of this code/wasm deployment)
  wasmHash: "immutable",
  deployedAtLedger: "immutable",
  creationTimestamp: "immutable",
  buildVersion: "immutable",
  supportedInterfaces: "immutable",
  specHash: "immutable",
  symbol: "immutable",
  decimals: "immutable",

  // Version-scoped (immutable for a specific WASM version / schema revision)
  capabilities: "version_scoped",
  feeScheduleVersion: "version_scoped",
  abiSpec: "version_scoped",
  roleDefinitions: "version_scoped",
  version: "version_scoped",

  // Mutable (dynamic gameplay/accounting state — forbidden in this cache)
  currentRound: "mutable",
  balance: "mutable",
  adminAddress: "mutable",
  isPaused: "mutable",
  playerStakes: "mutable",
  survivorCount: "mutable",
};

export interface CanonicalContractIdentity {
  network: string;
  contractId: string;
  wasmHash: string;
  schemaVersion?: number | undefined;
}

export interface CachedMetadataEntry<T = unknown> {
  key: string;
  identity: CanonicalContractIdentity;
  metadataClass: MetadataClass;
  data: T;
  checksum: string;
  cachedAt: number;
}

const DEFAULT_SCHEMA_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for immutable data

export class ContractMetadataCache {
  private memoryCache = new Map<string, CachedMetadataEntry>();
  private inFlightRequests = new Map<string, Promise<any>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(options: { maxEntries?: number | undefined; ttlMs?: number | undefined } = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  buildCanonicalKey(identity: CanonicalContractIdentity): string {
    const schemaVer = identity.schemaVersion ?? DEFAULT_SCHEMA_VERSION;
    return `contract_meta:${identity.network}:${identity.contractId}:${identity.wasmHash}:v${schemaVer}`;
  }

  isFieldCacheable(field: string): boolean {
    const classification = FIELD_CLASSIFICATION_REGISTRY[field];
    return classification === "immutable" || classification === "version_scoped";
  }

  computeChecksum(data: unknown): string {
    const serialized = JSON.stringify(data);
    return createHash("sha256").update(serialized).digest("hex");
  }

  /**
   * Resolves metadata with single-flight request coalescing (cold-miss deduplication),
   * integrity validation, and strict classification enforcement.
   */
  async getOrFetch<T>(
    identity: CanonicalContractIdentity,
    metadataClass: MetadataClass,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    if (metadataClass === "mutable") {
      throw new Error(
        "Mutable contract state must NEVER be cached in ContractMetadataCache",
      );
    }

    const key = this.buildCanonicalKey(identity);
    const now = Date.now();
    const startedAt = process.hrtime.bigint();

    // 1. Check in-memory cache
    const existing = this.memoryCache.get(key);
    if (existing) {
      if (now - existing.cachedAt < this.ttlMs) {
        // Validate integrity checksum
        const currentChecksum = this.computeChecksum(existing.data);
        if (currentChecksum === existing.checksum) {
          contractMetadataCacheHitsTotal.inc({ metadata_class: metadataClass });
          const elapsed = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
          contractMetadataLookupDuration.observe({ status: "hit" }, elapsed);
          return existing.data as T;
        } else {
          // Corrupted entry detected
          this.invalidateKey(key, "corrupted_entry");
          logger.warn(
            { key, expected: existing.checksum, actual: currentChecksum },
            "Contract metadata cache entry corrupted; purging",
          );
        }
      } else {
        this.invalidateKey(key, "ttl_expired");
      }
    }

    // 2. Single-flight cold-miss deduplication (Coalescing)
    contractMetadataCacheMissesTotal.inc({ metadata_class: metadataClass });

    const inFlight = this.inFlightRequests.get(key);
    if (inFlight) {
      return inFlight as Promise<T>;
    }

    const fetchPromise = (async () => {
      try {
        const fetchedData = await fetcher();
        const checksum = this.computeChecksum(fetchedData);

        // Enforce bounded cache size
        if (this.memoryCache.size >= this.maxEntries) {
          const oldestKey = this.memoryCache.keys().next().value;
          if (oldestKey) this.memoryCache.delete(oldestKey);
        }

        const entry: CachedMetadataEntry<T> = {
          key,
          identity,
          metadataClass,
          data: fetchedData,
          checksum,
          cachedAt: Date.now(),
        };

        this.memoryCache.set(key, entry);
        const elapsed = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
        contractMetadataLookupDuration.observe({ status: "miss" }, elapsed);
        return fetchedData;
      } finally {
        this.inFlightRequests.delete(key);
      }
    })();

    this.inFlightRequests.set(key, fetchPromise);
    return fetchPromise;
  }

  /**
   * Invalidation triggered when contract upgrade or state rollback is detected.
   */
  invalidateContract(contractId: string, reason: InvalidationReason): number {
    let count = 0;
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.identity.contractId === contractId) {
        this.memoryCache.delete(key);
        count++;
      }
    }

    contractMetadataCacheInvalidationsTotal.inc({ reason });
    logger.info(
      { event: "contract_metadata_invalidated", contractId, reason, count },
      "Invalidated contract metadata cache entries",
    );
    return count;
  }

  invalidateKey(key: string, reason: InvalidationReason): boolean {
    const deleted = this.memoryCache.delete(key);
    if (deleted) {
      contractMetadataCacheInvalidationsTotal.inc({ reason });
    }
    return deleted;
  }

  clear(): void {
    this.memoryCache.clear();
    this.inFlightRequests.clear();
  }

  size(): number {
    return this.memoryCache.size;
  }

  getEntry(key: string): CachedMetadataEntry | undefined {
    return this.memoryCache.get(key);
  }

  setCorruptedEntryForTest(key: string, badData: any): void {
    const entry = this.memoryCache.get(key);
    if (entry) {
      entry.data = badData;
    }
  }
}

export const contractMetadataCache = new ContractMetadataCache();
