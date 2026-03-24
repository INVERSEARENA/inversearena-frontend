import { describe, it, expect } from "@jest/globals";
import { BASE_FEE } from "@stellar/stellar-sdk";
import { TRANSACTION_CONFIG } from "@/components/hook-d/arenaConstants";
import {
  getDefaultInvokeBaseFee,
  getInfiniteTimeout,
  getJoinArenaFee,
  getShortTxTimeoutSeconds,
  getStandardTxTimeoutSeconds,
  getSubmitRetryConfig,
} from "../stellar-fee-estimator";

describe("stellar-fee-estimator", () => {
  it("exposes SDK base fee for default invokes", () => {
    expect(getDefaultInvokeBaseFee()).toBe(BASE_FEE);
  });

  it("join fee matches arena transaction config", () => {
    expect(getJoinArenaFee()).toBe(TRANSACTION_CONFIG.JOIN_FEE);
  });

  it("standard timeout matches config", () => {
    expect(getStandardTxTimeoutSeconds()).toBe(
      TRANSACTION_CONFIG.TIMEOUT_SECONDS,
    );
  });

  it("short timeout is fixed at 30s", () => {
    expect(getShortTxTimeoutSeconds()).toBe(30);
  });

  it("returns infinite timeout token from SDK", () => {
    expect(getInfiniteTimeout()).toBeDefined();
  });

  it("retry config mirrors TRANSACTION_CONFIG", () => {
    const cfg = getSubmitRetryConfig();
    expect(cfg.maxRetries).toBe(TRANSACTION_CONFIG.MAX_RETRIES);
    expect(cfg.retryIntervalMs).toBe(TRANSACTION_CONFIG.RETRY_INTERVAL_MS);
  });
});
