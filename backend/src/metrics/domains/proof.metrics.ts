/**
 * Proof Bundle & Dispute Evidence Cache Metrics Domain (#1775)
 */

import {
  createCounter,
  createHistogram,
  createGauge,
} from "../registry";

// Proof Generation Metrics (async background generation)
export const proofGenerationDuration = createHistogram(
  {
    name: "inversearena_proof_generation_duration_seconds",
    help: "Proof bundle generation duration in seconds",
    labelNames: ["kind"], // bundle or evidence
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  },
  { domain: "proof" },
);

// Cache Performance Metrics
export const proofCacheHits = createCounter(
  {
    name: "inversearena_proof_cache_hits_total",
    help: "Total number of proof cache hits",
    labelNames: ["kind"], // bundle or evidence
  },
  { domain: "proof" },
);

export const proofCacheMisses = createCounter(
  {
    name: "inversearena_proof_cache_misses_total",
    help: "Total number of proof cache misses",
    labelNames: ["kind"], // bundle or evidence
  },
  { domain: "proof" },
);

// Storage Metrics
export const proofStorageSize = createGauge(
  {
    name: "inversearena_proof_storage_bytes",
    help: "Total size of proof artifacts in bytes",
  },
  { domain: "proof" },
);

export const proofArtifactsTotal = createGauge(
  {
    name: "inversearena_proof_artifacts_total",
    help: "Total number of proof artifacts stored",
    labelNames: ["kind"], // bundle or evidence
  },
  { domain: "proof" },
);
