/**
 * Legacy central metrics facade (#1750).
 *
 * All metrics have been partitioned into domain-owned modules under `src/metrics/domains/`.
 * This file re-exports everything to preserve complete backwards compatibility during the transition.
 */

export * from "../metrics/registry";
export * from "../metrics/domains/http.metrics";
export * from "../metrics/domains/queue.metrics";
export * from "../metrics/domains/poller.metrics";
export * from "../metrics/domains/payments.metrics";
export * from "../metrics/domains/round.metrics";
export * from "../metrics/domains/soroban.metrics";
export * from "../metrics/domains/ops.metrics";
export * from "../metrics/domains/auth.metrics";
export * from "../metrics/domains/proof.metrics";
