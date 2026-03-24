import { BASE_FEE, TimeoutInfinite } from "@stellar/stellar-sdk";
import { TRANSACTION_CONFIG } from "@/components/hook-d/arenaConstants";

/** Default Soroban invoke base fee (Stellar SDK constant). */
export function getDefaultInvokeBaseFee(): string {
  return BASE_FEE;
}

/** Join-arena operation uses a higher configured fee. */
export function getJoinArenaFee(): string {
  return TRANSACTION_CONFIG.JOIN_FEE;
}

/** Standard timeout (seconds) for pool interactions. */
export function getStandardTxTimeoutSeconds(): number {
  return TRANSACTION_CONFIG.TIMEOUT_SECONDS;
}

/** Claim / read paths that use a fixed short timeout. */
export function getShortTxTimeoutSeconds(): number {
  return 30;
}

export function getInfiniteTimeout(): typeof TimeoutInfinite {
  return TimeoutInfinite;
}

export function getSubmitRetryConfig(): {
  maxRetries: number;
  retryIntervalMs: number;
} {
  return {
    maxRetries: TRANSACTION_CONFIG.MAX_RETRIES,
    retryIntervalMs: TRANSACTION_CONFIG.RETRY_INTERVAL_MS,
  };
}
