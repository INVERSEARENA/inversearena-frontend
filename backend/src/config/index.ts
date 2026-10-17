import { validateBackendEnv, type BackendConfig } from "./env";
import { validateConfig } from "./validate";
import { getStellarConfig } from "./stellarConfig";
import { getPaymentConfig } from "./paymentConfig";
import { getTreasuryConfig } from "./treasuryConfig";
import { getOracleFreshnessConfig } from "./oracleFreshnessConfig";
import { checkRotationReadiness, loadKeyring, type SecretKeyring } from "./secretKeyring";

/**
 * Singleton typed backend configuration, validated against Zod schema.
 */
let cachedConfig: BackendConfig | null = null;

export function getConfig(): BackendConfig {
  if (!cachedConfig) {
    cachedConfig = validateBackendEnv(process.env);
  }
  return cachedConfig;
}

export const config = new Proxy({} as BackendConfig, {
  get(_target, prop: string | symbol) {
    const active = getConfig();
    return (active as Record<string | symbol, unknown>)[prop];
  },
});

export {
  validateConfig,
  validateBackendEnv,
  getStellarConfig,
  getPaymentConfig,
  getTreasuryConfig,
  getOracleFreshnessConfig,
  checkRotationReadiness,
  loadKeyring,
  type BackendConfig,
  type SecretKeyring,
};
