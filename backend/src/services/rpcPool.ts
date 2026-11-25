import {
  SorobanRpcPool,
  type ProviderHealthStats,
} from "../../../frontend/src/shared/lib/stellar/sorobanRpcPool";
import { getStellarConfig } from "../config/stellarConfig";
import {
  sorobanRpcProviderHealthScore,
  sorobanRpcProviderLatencySeconds,
  sorobanRpcProviderLedgerLag,
  sorobanRpcProviderStatus,
  sorobanRpcFailoversTotal,
  sorobanRpcProviderErrorsTotal,
} from "../metrics/domains/soroban.metrics";

let backendRpcPool: SorobanRpcPool | null = null;

function publishPoolMetrics(stats: ProviderHealthStats[]): void {
  for (const s of stats) {
    sorobanRpcProviderHealthScore.set({ provider: s.url }, s.healthScore);
    sorobanRpcProviderLatencySeconds.set({ provider: s.url }, s.latencyMs / 1000);
    sorobanRpcProviderLedgerLag.set({ provider: s.url }, s.ledgerLag);
    sorobanRpcProviderStatus.set(
      {
        provider: s.url,
        status: s.isHealthy ? "healthy" : s.isLagging ? "lagging" : "down",
      },
      s.isHealthy ? 1 : 0,
    );
  }
}

export function getBackendRpcPool(): SorobanRpcPool {
  if (!backendRpcPool) {
    const cfg = getStellarConfig();
    backendRpcPool = new SorobanRpcPool({
      urls: cfg.sorobanRpcUrls,
      maxLedgerLag: cfg.sorobanMaxLedgerLag,
      onMetricsUpdate: publishPoolMetrics,
      onFailover: (fromUrl, toUrl, reason) => {
        sorobanRpcFailoversTotal.inc({ from_provider: fromUrl, to_provider: toUrl });
        const errorType = reason.includes("timed out") ? "timeout" : "rpc_error";
        sorobanRpcProviderErrorsTotal.inc({ provider: fromUrl, error_type: errorType });
      },
    });
  }
  return backendRpcPool;
}

export function resetBackendRpcPoolForTest(): void {
  backendRpcPool = null;
}
