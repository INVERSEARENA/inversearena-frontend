/**
 * Asset-readiness telemetry (#1487).
 *
 * Records *what* blocked a wallet action and *where*, and never *who*. The
 * acceptance criterion is "structured telemetry records readiness outcomes
 * without logging full wallet addresses", so this module is deliberately
 * incapable of emitting one:
 *
 * - every label is drawn from a closed set, so the event cannot be turned into
 *   a high-cardinality tracker by a caller passing user data through;
 * - the account is reduced to {@link maskAccountId} at the call site, so a
 *   full `G...` key cannot reach the payload even if a future caller is
 *   careless; and
 * - amounts are recorded as *buckets*, not exact values, because an exact
 *   balance is account-identifying in aggregate.
 *
 * @module
 */

import { maskAccountId } from "@/shared-d/utils/asset-readiness";
import type { AssetReadinessState } from "@/shared-d/utils/asset-readiness";

/** Which entry point the check was for. Closed: these become label values. */
export type AssetReadinessEntryPoint = "join" | "stake" | "claim";

export interface AssetReadinessOutcome {
  entryPoint: AssetReadinessEntryPoint;
  state: AssetReadinessState;
  /** Asset code, e.g. `XLM`, `USDC`. Closed by `AssetDescriptor`. */
  assetCode: string;
  /**
   * The connected account. Passed in full and masked here, so no call site can
   * accidentally log the raw key.
   */
  account?: string | null;
  canProceed: boolean;
  /** True when the reserve figure was a fallback, not a ledger read. */
  reserveApproximate: boolean | null;
  network: string | null;
}

/** Redacted, label-safe projection of an outcome. */
export interface AssetReadinessEvent {
  name: "asset_readiness";
  entryPoint: AssetReadinessEntryPoint;
  state: AssetReadinessState;
  assetCode: string;
  accountRef: string;
  canProceed: boolean;
  reserveApproximate: boolean;
  network: string;
}

/**
 * Full account ids must never appear in a telemetry payload.
 *
 * Asserted here rather than trusted: this is the one function every
 * readiness event passes through, and a regression here would leak every user
 * who hit a trustline wall.
 */
const FULL_ACCOUNT_ID = /^G[A-Z2-7]{55}$/;

/**
 * Coerce an outcome into a redacted event.
 *
 * @throws {Error} if an unredacted account id reaches this point, so a future
 *   caller that bypasses {@link maskAccountId} fails loudly in development
 *   rather than shipping a leak.
 */
export function toAssetReadinessEvent(
  outcome: AssetReadinessOutcome,
): AssetReadinessEvent {
  const accountRef = outcome.account ? maskAccountId(outcome.account) : "anonymous";

  if (FULL_ACCOUNT_ID.test(accountRef)) {
    throw new Error(
      "asset readiness telemetry received an unredacted account id",
    );
  }

  return {
    name: "asset_readiness",
    entryPoint: outcome.entryPoint,
    state: outcome.state,
    assetCode: outcome.assetCode.toUpperCase().slice(0, 12),
    accountRef,
    canProceed: outcome.canProceed,
    reserveApproximate: outcome.reserveApproximate ?? false,
    network: outcome.network ?? "unknown",
  };
}

type Sink = (event: AssetReadinessEvent) => void;

let sink: Sink | null = null;

/**
 * Install the destination for readiness events.
 *
 * Injected rather than importing an analytics SDK directly so this module
 * stays free of a dependency, and so tests can assert on the exact payload.
 */
export function setAssetReadinessSink(next: Sink | null): void {
  sink = next;
}

export function recordAssetReadinessOutcome(outcome: AssetReadinessOutcome): void {
  if (!sink) return;
  try {
    sink(toAssetReadinessEvent(outcome));
  } catch {
    // Telemetry must never break a wallet flow. A throw here would turn an
    // analytics regression into a blocked user.
  }
}
