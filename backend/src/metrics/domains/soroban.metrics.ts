/**
 * Soroban & Contract Metrics Domain (#1750)
 */

import {
  createCounter,
  createGauge,
  createHistogram,
} from "../registry";

// 0 = closed (healthy), 1 = half-open (probing), 2 = open (failing)
export const sorobanCircuitBreakerState = createGauge(
  {
    name: "inversearena_soroban_circuit_breaker_state",
    help: "Soroban RPC circuit breaker state: 0=closed, 1=half-open, 2=open",
  },
  { domain: "soroban" },
);

export const sorobanCircuitTransitionsTotal = createCounter(
  {
    name: "inversearena_soroban_circuit_transitions_total",
    help: "Total Soroban RPC circuit breaker state transitions",
    labelNames: ["to_state"],
  },
  { domain: "soroban" },
);

export const sorobanSimulationHitsTotal = createCounter(
  {
    name: "inversearena_soroban_simulation_cache_hits_total",
    help: "Soroban read simulation single-flight cache hits",
  },
  { domain: "soroban" },
);

export const sorobanSimulationMissesTotal = createCounter(
  {
    name: "inversearena_soroban_simulation_cache_misses_total",
    help: "Soroban read simulation single-flight cache misses",
    labelNames: ["reason"],
  },
  { domain: "soroban" },
);

export const sorobanSimulationCoalescedWaitersTotal = createCounter(
  {
    name: "inversearena_soroban_simulation_coalesced_waiters_total",
    help: "Concurrent identical Soroban simulations that shared one in-flight RPC",
  },
  { domain: "soroban" },
);

export const sorobanSimulationCacheEvictionsTotal = createCounter(
  {
    name: "inversearena_soroban_simulation_cache_evictions_total",
    help: "Evictions from the bounded Soroban simulation result cache",
  },
  { domain: "soroban" },
);

// #1409: contract capability negotiation across mixed deployment versions
export const capabilityNegotiationsTotal = createCounter(
  {
    name: "inversearena_capability_negotiations_total",
    help: "Contract capability negotiation attempts, by contract kind and outcome (success/failure/retry)",
    labelNames: ["contract", "outcome"],
  },
  { domain: "soroban" },
);

export const capabilityNegotiationDuration = createHistogram(
  {
    name: "inversearena_capability_negotiation_duration_seconds",
    help: "Time to resolve a contract's negotiated capability set, including retries",
    labelNames: ["contract"],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  },
  { domain: "soroban" },
);

export const capabilityCacheHitsTotal = createCounter(
  {
    name: "inversearena_capability_cache_hits_total",
    help: "Capability negotiation results served from the in-memory version cache instead of a fresh on-chain read",
    labelNames: ["contract"],
  },
  { domain: "soroban" },
);

// #1526: Immutable Contract Metadata Cache by WASM Identity Metrics
export const contractMetadataCacheHitsTotal = createCounter(
  {
    name: "inversearena_contract_metadata_cache_hits_total",
    help: "Contract metadata cache hits by metadata class (immutable/version_scoped)",
    labelNames: ["metadata_class"],
  },
  { domain: "soroban" },
);

export const contractMetadataCacheMissesTotal = createCounter(
  {
    name: "inversearena_contract_metadata_cache_misses_total",
    help: "Contract metadata cache misses by metadata class (immutable/version_scoped)",
    labelNames: ["metadata_class"],
  },
  { domain: "soroban" },
);

export const contractMetadataCacheInvalidationsTotal = createCounter(
  {
    name: "inversearena_contract_metadata_cache_invalidations_total",
    help: "Contract metadata cache invalidations by reason (upgrade/manual/corrupted/ttl)",
    labelNames: ["reason"],
  },
  { domain: "soroban" },
);

export const contractMetadataLookupDuration = createHistogram(
  {
    name: "inversearena_contract_metadata_lookup_duration_seconds",
    help: "Contract metadata resolution duration in seconds",
    labelNames: ["status"],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  },
  { domain: "soroban" },
);

// #1830: Multi-provider Soroban RPC pool metrics
export const sorobanRpcProviderHealthScore = createGauge(
  {
    name: "inversearena_soroban_rpc_provider_health_score",
    help: "Computed health score (0-100) for each Soroban RPC provider",
    labelNames: ["provider"],
  },
  { domain: "soroban" },
);

export const sorobanRpcProviderLatencySeconds = createGauge(
  {
    name: "inversearena_soroban_rpc_provider_latency_seconds",
    help: "Rolling average request latency in seconds per Soroban RPC provider",
    labelNames: ["provider"],
  },
  { domain: "soroban" },
);

export const sorobanRpcProviderErrorsTotal = createCounter(
  {
    name: "inversearena_soroban_rpc_provider_errors_total",
    help: "Total RPC errors per Soroban RPC provider",
    labelNames: ["provider", "error_type"],
  },
  { domain: "soroban" },
);

export const sorobanRpcProviderLedgerLag = createGauge(
  {
    name: "inversearena_soroban_rpc_provider_ledger_lag",
    help: "Number of ledgers this provider lags behind the pool highest known ledger",
    labelNames: ["provider"],
  },
  { domain: "soroban" },
);

export const sorobanRpcProviderStatus = createGauge(
  {
    name: "inversearena_soroban_rpc_provider_status",
    help: "Provider availability status (1=healthy, 0=lagging or down)",
    labelNames: ["provider", "status"],
  },
  { domain: "soroban" },
);

export const sorobanRpcFailoversTotal = createCounter(
  {
    name: "inversearena_soroban_rpc_failovers_total",
    help: "Total Soroban RPC failovers between providers",
    labelNames: ["from_provider", "to_provider"],
  },
  { domain: "soroban" },
);
