import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  ContractMetadataCache,
  FIELD_CLASSIFICATION_REGISTRY,
  type CanonicalContractIdentity,
} from "../src/services/contractMetadataCache";
import {
  contractMetadataCacheHitsTotal,
  contractMetadataCacheMissesTotal,
  contractMetadataCacheInvalidationsTotal,
} from "../src/utils/metrics";

describe("Contract Metadata Cache by Deployment & WASM Identity (#1526)", () => {
  let cache: ContractMetadataCache;

  beforeEach(() => {
    cache = new ContractMetadataCache({ maxEntries: 100, ttlMs: 10_000 });
  });

  const identityV1: CanonicalContractIdentity = {
    network: "testnet",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    wasmHash: "1111111111111111111111111111111111111111111111111111111111111111",
    schemaVersion: 1,
  };

  const identityV2: CanonicalContractIdentity = {
    network: "testnet",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    wasmHash: "2222222222222222222222222222222222222222222222222222222222222222",
    schemaVersion: 1,
  };

  describe("Canonical Cache Key Construction", () => {
    it("generates deterministic canonical keys containing network, contract, wasm hash, and schema version", () => {
      const key = cache.buildCanonicalKey(identityV1);
      expect(key).toBe(
        `contract_meta:testnet:${identityV1.contractId}:${identityV1.wasmHash}:v1`,
      );
    });
  });

  describe("Field Classification Registry", () => {
    it("allows caching for immutable and version-scoped metadata fields", () => {
      expect(cache.isFieldCacheable("wasmHash")).toBe(true);
      expect(cache.isFieldCacheable("deployedAtLedger")).toBe(true);
      expect(cache.isFieldCacheable("capabilities")).toBe(true);
      expect(cache.isFieldCacheable("abiSpec")).toBe(true);
    });

    it("forbids caching mutable gameplay and accounting fields", async () => {
      expect(cache.isFieldCacheable("currentRound")).toBe(false);
      expect(cache.isFieldCacheable("balance")).toBe(false);
      expect(cache.isFieldCacheable("playerStakes")).toBe(false);

      await expect(
        cache.getOrFetch(identityV1, "mutable", async () => ({ currentRound: 5 })),
      ).rejects.toThrow("Mutable contract state must NEVER be cached");
    });
  });

  describe("Single-Flight Cold-Miss Deduplication (Request Coalescing)", () => {
    it("coalesces concurrent requests for the same key into a single underlying fetch", async () => {
      let fetchCallCount = 0;
      const fetcher = async () => {
        fetchCallCount++;
        await new Promise((r) => setTimeout(r, 20)); // simulate 20ms RPC latency
        return { supportedInterfaces: ["IERC20", "IArena"] };
      };

      // Launch 5 concurrent calls
      const [r1, r2, r3, r4, r5] = await Promise.all([
        cache.getOrFetch(identityV1, "immutable", fetcher),
        cache.getOrFetch(identityV1, "immutable", fetcher),
        cache.getOrFetch(identityV1, "immutable", fetcher),
        cache.getOrFetch(identityV1, "immutable", fetcher),
        cache.getOrFetch(identityV1, "immutable", fetcher),
      ]);

      expect(fetchCallCount).toBe(1);
      expect(r1).toEqual({ supportedInterfaces: ["IERC20", "IArena"] });
      expect(r2).toEqual(r1);
      expect(r3).toEqual(r1);
      expect(r4).toEqual(r1);
      expect(r5).toEqual(r1);
    });
  });

  describe("Integrity Checksum Validation", () => {
    it("detects and purges corrupted cache entries on read", async () => {
      const data = { specHash: "valid-hash" };
      await cache.getOrFetch(identityV1, "immutable", async () => data);

      const key = cache.buildCanonicalKey(identityV1);
      expect(cache.getEntry(key)).toBeDefined();

      // Corrupt the cached data in-place
      cache.setCorruptedEntryForTest(key, { specHash: "tampered-hash" });

      let fetchCount = 0;
      const healedData = await cache.getOrFetch(identityV1, "immutable", async () => {
        fetchCount++;
        return { specHash: "refetched-hash" };
      });

      expect(fetchCount).toBe(1);
      expect(healedData.specHash).toBe("refetched-hash");
    });
  });

  describe("Upgrade Detection & Invalidation", () => {
    it("invalidates old WASM entries when contract upgrade is detected", async () => {
      await cache.getOrFetch(identityV1, "version_scoped", async () => ({
        version: 1,
        capabilities: ["commit", "reveal"],
      }));

      expect(cache.size()).toBe(1);

      // Upgrade detected
      const invalidatedCount = cache.invalidateContract(
        identityV1.contractId,
        "upgrade_detected",
      );
      expect(invalidatedCount).toBe(1);
      expect(cache.size()).toBe(0);

      // Next fetch for new WASM identity works cleanly
      const v2Data = await cache.getOrFetch(identityV2, "version_scoped", async () => ({
        version: 2,
        capabilities: ["commit", "reveal", "sponsor_yield"],
      }));

      expect(v2Data.version).toBe(2);
      expect(v2Data.capabilities).toContain("sponsor_yield");
    });

    it("handles rollback invalidation cleanly", async () => {
      await cache.getOrFetch(identityV2, "version_scoped", async () => ({ version: 2 }));
      cache.invalidateContract(identityV2.contractId, "rollback");
      expect(cache.size()).toBe(0);
    });
  });

  describe("RPC Failure Handling", () => {
    it("does not poison the cache on fetch errors", async () => {
      let callCount = 0;
      const failingFetcher = async () => {
        callCount++;
        throw new Error("RPC node timeout");
      };

      await expect(
        cache.getOrFetch(identityV1, "immutable", failingFetcher),
      ).rejects.toThrow("RPC node timeout");

      expect(cache.size()).toBe(0);

      // Subsequent successful call succeeds
      const successful = await cache.getOrFetch(identityV1, "immutable", async () => ({
        creationTimestamp: 1700000000,
      }));
      expect(successful.creationTimestamp).toBe(1700000000);
      expect(cache.size()).toBe(1);
    });
  });
});
