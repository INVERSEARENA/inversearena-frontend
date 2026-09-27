/**
 * Typed asset-readiness preflight (#1487).
 *
 * A preflight answers one question before the user is ever asked to sign:
 * *can this account actually receive the asset this action needs?* It runs
 * ahead of `buildJoinArenaTransaction`, `buildStakeProtocolTransaction` and
 * `buildClaimWinningsTransaction` so a missing trustline, an exhausted limit
 * or an unfunded base reserve surfaces as a deterministic, explainable state
 * instead of a mid-signing failure that costs a network fee.
 *
 * ## Why a discriminated union
 *
 * The alternative — a boolean plus a message — cannot express "we could not
 * find out". Every state here is terminal and mutually exclusive, so the
 * caller narrows on `state` and TypeScript proves the recovery path is
 * handled. `unavailable` is deliberately its own state rather than a
 * throw: an RPC/Horizon failure must render a retry, never a claim that the
 * wallet is (or is not) ready.
 *
 * ## Arithmetic
 *
 * Every amount crossing this boundary is a `bigint` of stroops. A `number`
 * cannot represent 92,233,720,368 (the default `changeTrust` limit) plus a
 * balance without losing precision, and a trustline balance may legitimately
 * be negative, which is what a liability is. Display formatting happens once,
 * at the edge, via {@link stroopsToAmount}.
 *
 * @module
 */

import {
  StellarAssetReadError,
  amountToStroops,
  findCreditBalance,
  readAccountAssetSnapshot,
  stroopsToAmount,
  trustlineHeadroomStroops,
  type AccountAssetSnapshot,
  type AssetBalance,
  type AssetDescriptor,
  type AssetReadDeps,
  type AssetReadFailureReason,
  type TrustlineAuthorization,
} from "@/shared-d/utils/stellar-asset-reader";

/**
 * The trustline limit requested by the default remediation: the exact amount
 * being received plus whatever balance the account already holds, so an
 * existing position is not orphaned by the new cap.
 *
 * There is deliberately no "N times the transaction amount" heuristic here.
 * Stellar prescribes no such rule, and picking a multiplier silently would
 * mean the UI quotes a limit the user never chose. The no-limit alternative is
 * offered as an explicit opt-in instead.
 */
export const DEFAULT_TRUSTLINE_LIMIT_HEADROOM_STROOPS = 0n;

/**
 * The no-limit alternative offered alongside the default cap.
 *
 * This is the SDK's behaviour when `limit` is omitted: `int64` max, i.e.
 * 922337203685.4775807 units. Surfaced as a value rather than applied as a
 * default so the user has to choose it.
 */
export const UNLIMITED_TRUSTLINE_LIMIT = "922337203685.4775807";

/**
 * Protocol minimum inclusion bid for a one-operation transaction, in stroops.
 * Used only to quote a floor for the estimated fee when the ledger read did
 * not return a base fee.
 */
export const MINIMUM_BASE_FEE_STROOPS = 100n;

/** What a caller needs from an asset before its business action can proceed. */
export interface AssetRequirement {
  asset: AssetDescriptor;
  /**
   * Amount the action needs to *receive*, in display units. Omit or pass `0`
   * to only ask "can this account hold this asset at all?".
   */
  amount?: number;
}

/** Fields present on every terminal readiness state. */
export interface AssetReadinessBase {
  asset: AssetDescriptor;
  /** The asset's code, for display and for telemetry's `assetCode` label. */
  assetCode: string;
  /** Whether the connected account could be read at all. */
  snapshot: {
    observedAtMs: number;
    lastModifiedLedger: number | null;
    /**
     * True when the base reserve came from the protocol fallback rather than
     * a ledger read, i.e. the reserve numbers below are approximate.
     */
    baseReserveApproximate: boolean;
  } | null;
}

/**
 * A `changeTrust` the user can build, sign, submit and reconcile without
 * leaving the flow it was triggered from. Carries everything the confirmation
 * UI must state *before* the wallet prompt appears.
 */
export interface TrustlineRemediation {
  asset: Extract<AssetDescriptor, { kind: "credit" }>;
  issuer: string;
  /**
   * The limit to request, as a decimal amount string — exactly what goes into
   * `Operation.changeTrust({ limit })`.
   */
  limit: string;
  limitStroops: bigint;
  /**
   * XLM the transaction adds to the account's minimum balance. Zero when the
   * trustline already exists, because a `changeTrust` that updates an existing
   * line does not create a new subentry.
   */
  reserveImpactStroops: bigint;
  /**
   * Whether `limit` is exactly what the pending action needs. `false` means
   * the caller asked for a larger cap than required.
   */
  exact: boolean;
  /** Lower bound on the network fee, in stroops. `changeTrust` is one op. */
  estimatedFeeStroops: bigint;
  /**
   * The issuer has `AUTH_REQUIRED`, so creating the trustline is necessary but
   * not sufficient — the issuer must authorize it separately before the holder
   * can receive the asset. Surfaced so the UI can say so up front.
   */
  requiresIssuerAuthorization: boolean;
  /** Issuer can revoke this trustline once authorized. */
  issuerCanRevoke: boolean;
  /** Issuer can claw back balances. */
  issuerClawbackEnabled: boolean;
  issuerHomeDomain: string | null;
  /** Horizon's identifier of the account the re-read must target. */
  readBackAccountId: string;
}

/** The terminal states a preflight can resolve to. */
export type AssetReadinessState =
  /** The asset is native XLM — no trustline concept applies. */
  | "native"
  /** A trustline exists, is authorized, and has room for the amount. */
  | "ready"
  /** No trustline for this `(code, issuer)`; a `changeTrust` would create one. */
  | "missing_trustline"
  /** A trustline exists but its limit cannot absorb the amount. */
  | "insufficient_limit"
  /** A trustline could be created, but the account cannot fund the subentry. */
  | "insufficient_reserve"
  /** A trustline exists but the issuer has deauthorized it. */
  | "unauthorized"
  /** The configured issuer account does not exist on this network. */
  | "issuer_not_found"
  /** The connected account does not exist on this network yet. */
  | "account_not_found"
  /** The asset descriptor itself is unusable (bad code, issuer is the holder). */
  | "invalid_asset"
  /** The read failed; retry, do not guess. */
  | "unavailable";

export type AssetReadiness =
  | (AssetReadinessBase & {
      state: "native";
      balanceStroops: bigint;
      /** Always true for `native`; the caller can branch on it directly. */
      canProceed: true;
      /** Nothing to repair. */
      remediation: null;
    })
  | (AssetReadinessBase & {
      state: "ready";
      balanceStroops: bigint;
      limitStroops: bigint;
      headroomStroops: bigint;
      authorization: "full";
      canProceed: true;
      /** Nothing to repair. */
      remediation: null;
    })
  | (AssetReadinessBase & {
      state: "missing_trustline" | "insufficient_limit";
      balanceStroops: bigint;
      limitStroops: bigint;
      /** Limit capacity remaining, in stroops. Never negative here. */
      headroomStroops: bigint;
      requiredStroops: bigint;
      /** How much more limit the trustline needs, in stroops. */
      shortfallStroops: bigint;
      canProceed: false;
      /**
       * Non-null by construction. A state that means "a `changeTrust` will
       * unblock this" is not representable without the instructions to build
       * one, so the UI can never reach the guided flow and find nothing to
       * sign.
       */
      remediation: TrustlineRemediation;
    })
  | (AssetReadinessBase & {
      state: "insufficient_reserve";
      requiredStroops: bigint;
      /** XLM still needed before the subentry can be added, in stroops. */
      shortfallStroops: bigint;
      canProceed: false;
      /** Fund the account first, then return here; the trustline follows. */
      remediation: TrustlineRemediation;
    })
  | (AssetReadinessBase & {
      state: "unauthorized";
      authorization: TrustlineAuthorization;
      balanceStroops: bigint;
      limitStroops: bigint;
      /**
       * Always `null`: a deauthorized trustline cannot be repaired by the
       * holder. Recovery is an issuer-side `setTrustLineFlags`, which is out
       * of scope for a client-side flow. Offering a `changeTrust` here would
       * fail on chain and waste a signature.
       */
      remediation: null;
      canProceed: false;
    })
  | (AssetReadinessBase & {
      state: "issuer_not_found" | "account_not_found" | "invalid_asset";
      canProceed: false;
      /**
       * Always `null`. A missing issuer or a malformed descriptor is not
       * something the holder can sign their way out of.
       */
      remediation: null;
    })
  | (AssetReadinessBase & {
      state: "unavailable";
      reason: AssetReadFailureReason;
      message: string;
      canProceed: false;
      /** Always `null`: an unknown state must not offer a repair action. */
      remediation: null;
    });

/** True when the account may proceed to build the business transaction. */
export function isAssetReady(readiness: AssetReadiness): readiness is Extract<
  AssetReadiness,
  { canProceed: true }
> {
  return readiness.canProceed;
}

/** True when a holder-side `changeTrust` is the documented next step. */
export function hasTrustlineRemediation(
  readiness: AssetReadiness,
): readiness is AssetReadiness & { remediation: TrustlineRemediation } {
  return readiness.remediation !== null;
}

/** Terminal states that are retryable without changing the user's wallet. */
const RETRYABLE_STATES: ReadonlySet<AssetReadinessState> = new Set([
  "unavailable",
]);

export function isRetryableReadiness(readiness: AssetReadiness): boolean {
  return RETRYABLE_STATES.has(readiness.state);
}

function assetCodeOf(asset: AssetDescriptor): string {
  return asset.kind === "native" ? "XLM" : asset.code;
}

function snapshotMeta(
  snapshot: AccountAssetSnapshot | null,
): AssetReadinessBase["snapshot"] {
  if (!snapshot) return null;
  return {
    observedAtMs: snapshot.observedAtMs,
    lastModifiedLedger: snapshot.lastModifiedLedger,
    baseReserveApproximate: !snapshot.baseReserveFromLedger,
  };
}

function toStroopsOrNull(amount: number | undefined): bigint | null {
  if (amount === undefined || amount === null) return null;
  if (!Number.isFinite(amount) || amount < 0) return null;
  // Round up: an under-estimate would claim readiness the account lacks.
  const scaled = BigInt(Math.ceil(amount * 1e7));
  return scaled;
}

function validateAsset(asset: AssetDescriptor): string | null {
  if (asset.kind === "native") return null;
  const code = asset.code?.trim() ?? "";
  if (code.length < 1 || code.length > 12) {
    return "Asset code must be between 1 and 12 characters";
  }
  if (!/^[A-Za-z0-9]+$/.test(code)) {
    return "Asset code must be alphanumeric";
  }
  if (!asset.issuer) {
    return "Asset issuer is required";
  }
  return null;
}

function buildRemediation(params: {
  asset: Extract<AssetDescriptor, { kind: "credit" }>;
  requiredStroops: bigint;
  existingBalanceStroops: bigint;
  trustlineExists: boolean;
  snapshot: AccountAssetSnapshot;
  /** Limit ceiling, used only to decide the `exact` flag. */
  currentLimitStroops: bigint;
  exact: boolean;
}): TrustlineRemediation {
  const {
    asset,
    requiredStroops,
    existingBalanceStroops,
    trustlineExists,
    snapshot,
    currentLimitStroops,
    exact,
  } = params;

  const limitStroops =
    existingBalanceStroops + requiredStroops + DEFAULT_TRUSTLINE_LIMIT_HEADROOM_STROOPS;
  const effectiveLimit = limitStroops > currentLimitStroops ? limitStroops : currentLimitStroops;
  const baseFee = snapshot.baseFeeStroops ?? MINIMUM_BASE_FEE_STROOPS;

  return {
    asset,
    issuer: asset.issuer,
    limit: stroopsToAmount(effectiveLimit),
    limitStroops: effectiveLimit,
    // A `changeTrust` that updates an existing line adds no subentry, so it
    // costs no reserve. Only creating a new one does.
    reserveImpactStroops: trustlineExists ? 0n : snapshot.subentryCostStroops,
    exact: exact && effectiveLimit === currentLimitStroops,
    estimatedFeeStroops: baseFee,
    requiresIssuerAuthorization: snapshot.issuerFlags?.authRequired === true,
    issuerCanRevoke: snapshot.issuerFlags?.authRevocable === true,
    issuerClawbackEnabled: snapshot.issuerFlags?.authClawbackEnabled === true,
    issuerHomeDomain: snapshot.issuerHomeDomain,
    readBackAccountId: snapshot.publicKey,
  };
}

/**
 * Classify a snapshot against a requirement.
 *
 * Pure and synchronous: every network concern lives in
 * {@link preflightAssetReadiness}, which is what makes the whole state machine
 * — including the liability and reserve edge cases — testable from recorded
 * payloads with no network at all.
 */
export function classifyAssetReadiness(
  asset: AssetDescriptor,
  snapshot: AccountAssetSnapshot,
  requiredStroops: bigint,
): AssetReadiness {
  const assetCode = assetCodeOf(asset);
  const snapshot_ = snapshotMeta(snapshot);
  const base: AssetReadinessBase = {
    asset,
    assetCode,
    snapshot: snapshot_,
  };

  if (asset.kind === "native") {
    return {
      ...base,
      state: "native",
      balanceStroops: snapshot.nativeBalanceStroops,
      canProceed: true,
      remediation: null,
    };
  }

  const issuerNotFound: AssetReadiness = {
    ...base,
    state: "issuer_not_found",
    canProceed: false,
    remediation: null,
  };
  if (snapshot.issuerExists === false) return issuerNotFound;

  const balance: AssetBalance | null = findCreditBalance(
    snapshot.balances,
    asset.code,
    asset.issuer,
  );

  if (balance === null) {
    // Missing trustline. The blocker is reserve, not the asset itself — the
    // user may simply need to fund their account before anything can be added.
    const remediation = buildRemediation({
      asset,
      requiredStroops,
      existingBalanceStroops: 0n,
      trustlineExists: false,
      snapshot,
      currentLimitStroops: 0n,
      exact: true,
    });

    // `availableAboveReserveStroops` is `nativeBalance - sellingLiabilities -
    // minimumBalance`, so it is already net of what the account already owes
    // for existing subentries. A negative value means the account is below its
    // minimum balance right now.
    if (snapshot.availableAboveReserveStroops < snapshot.subentryCostStroops) {
      return {
        ...base,
        state: "insufficient_reserve",
        requiredStroops,
        shortfallStroops:
          snapshot.subentryCostStroops - snapshot.availableAboveReserveStroops,
        remediation,
        canProceed: false,
      };
    }

    return {
      ...base,
      state: "missing_trustline",
      balanceStroops: 0n,
      limitStroops: 0n,
      headroomStroops: 0n,
      requiredStroops,
      shortfallStroops: requiredStroops,
      remediation,
      canProceed: false,
    };
  }

  const balanceStroops = amountToStroops(balance.balance);
  const limitStroops = balance.limit === null ? 0n : amountToStroops(balance.limit);

  if (balance.authorization !== "full") {
    return {
      ...base,
      state: "unauthorized",
      authorization: balance.authorization,
      balanceStroops,
      limitStroops,
      canProceed: false,
      remediation: null,
    };
  }

  // `trustlineHeadroomStroops` subtracts buying liabilities. Omitting them is
  // the bug this accounts for: a limit that looks large enough can already be
  // fully committed to an open buy offer, and the payment would fail with
  // `op_buy_line_full` after the user had already signed.
  const headroomStroops = trustlineHeadroomStroops(balance);

  if (headroomStroops >= requiredStroops) {
    return {
      ...base,
      state: "ready",
      balanceStroops,
      limitStroops,
      headroomStroops,
      authorization: "full",
      canProceed: true,
      remediation: null,
    };
  }

  const remediation = buildRemediation({
    asset,
    requiredStroops,
    existingBalanceStroops: balanceStroops < 0n ? 0n : balanceStroops,
    trustlineExists: true,
    snapshot,
    currentLimitStroops: limitStroops,
    exact: false,
  });

  return {
    ...base,
    state: "insufficient_limit",
    balanceStroops,
    limitStroops,
    headroomStroops: headroomStroops > 0n ? headroomStroops : 0n,
    requiredStroops,
    shortfallStroops: requiredStroops - headroomStroops,
    remediation,
    canProceed: false,
  };
}

export interface PreflightAssetReadinessDeps extends AssetReadDeps {
  /** The account being preflighted. */
  publicKey: string;
  /** Pre-computed snapshot; skips the network entirely (tests, re-reads). */
  snapshot?: AccountAssetSnapshot;
}

/**
 * Run the preflight: read the account (and its issuer), then classify.
 *
 * The returned union always resolves — a Horizon failure becomes
 * `state: "unavailable"` carrying the machine-readable `reason`, never a
 * rejection. A preflight that can throw cannot gate a button.
 */
export async function preflightAssetReadiness(
  requirement: AssetRequirement,
  deps: PreflightAssetReadinessDeps,
): Promise<AssetReadiness> {
  const { asset } = requirement;

  const invalid: AssetReadiness = {
    asset,
    assetCode: assetCodeOf(asset),
    state: "invalid_asset",
    snapshot: null,
    remediation: null,
    canProceed: false,
  };

  const requiredStroops = toStroopsOrNull(requirement.amount);
  if (requiredStroops === null) return invalid;
  if (validateAsset(asset) !== null) return invalid;

  if (deps.snapshot && asset.kind === "credit" && asset.issuer === deps.snapshot.publicKey) {
    // A `changeTrust` whose source is also the issuer is rejected by the
    // network (`CHANGE_TRUST_SELF_NOT_ALLOWED`); catching it here keeps the
    // failure from surfacing mid-signing.
    return invalid;
  }

  let snapshot: AccountAssetSnapshot;
  if (deps.snapshot) {
    snapshot = deps.snapshot;
  } else {
    let read: AccountAssetSnapshot;
    try {
      read = await readAccountAssetSnapshot(
        deps.publicKey,
        asset.kind === "credit" ? asset.issuer : null,
        deps,
      );
    } catch (error) {
      return unavailableReadiness(asset, error);
    }
    snapshot = read;
  }

  if (asset.kind === "credit" && asset.issuer === snapshot.publicKey) {
    return invalid;
  }

  return classifyAssetReadiness(asset, snapshot, requiredStroops);
}

/**
 * Map a read failure onto a terminal state, preserving the machine-readable
 * reason so telemetry can separate "our network is down" from "this account
 * does not exist" without matching on a message string.
 */
function unavailableReadiness(
  asset: AssetDescriptor,
  error: unknown,
): AssetReadiness {
  const reason: AssetReadFailureReason =
    error instanceof StellarAssetReadError ? error.reason : "network_error";
  const message =
    error instanceof StellarAssetReadError
      ? error.message
      : "Asset readiness could not be determined";

  if (reason === "account_not_found") {
    return {
      asset,
      assetCode: assetCodeOf(asset),
      state: "account_not_found",
      snapshot: null,
      remediation: null,
      canProceed: false,
    };
  }

  return {
    asset,
    assetCode: assetCodeOf(asset),
    state: "unavailable",
    reason,
    message,
    snapshot: null,
    remediation: null,
    canProceed: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Presentation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Human-readable explanation for the current state.
 *
 * Deliberately free of wallet addresses so the result is safe to log; callers
 * that want a correlation handle log the transaction hash or a masked address
 * separately, never this string.
 */
export function describeAssetReadiness(readiness: AssetReadiness): string {
  const code = readiness.assetCode;
  switch (readiness.state) {
    case "native":
      return `XLM is the native asset; no trustline is required.`;
    case "ready":
      return `A ${code} trustline is active and has room for this transaction.`;
    case "missing_trustline":
      return `No ${code} trustline exists yet. Adding one is required before this transaction can settle.`;
    case "insufficient_limit":
      return `The ${code} trustline limit is too low for this amount. It must be raised before this transaction can settle.`;
    case "insufficient_reserve":
      return `The account cannot cover the ${stroopsToAmount(
        readiness.remediation?.reserveImpactStroops ?? 0n,
      )} XLM base reserve needed to hold ${code}. Fund the account first.`;
    case "unauthorized":
      return readiness.authorization === "deauthorized"
        ? `The ${code} trustline has been revoked by its issuer and cannot receive funds.`
        : `The ${code} trustline is partially deauthorized and cannot receive new funds.`;
    case "issuer_not_found":
      return `The configured ${code} issuer account does not exist on this network.`;
    case "account_not_found":
      return `The connected account does not exist on this network yet.`;
    case "invalid_asset":
      return `The configured ${code} asset metadata is not usable.`;
    case "unavailable":
      return `Asset readiness could not be checked (${readiness.reason}). Retry before continuing.`;
  }
}

/**
 * Masked form of an account id for display and for log lines.
 *
 * `first6...last4`, matching the backend's `maskWalletAddress` convention.
 * Callers that need a stable analytics key should use a keyed hash server-side
 * rather than treating this as an identifier.
 */
export function maskAccountId(publicKey: string): string {
  if (publicKey.length <= 12) return publicKey;
  return `${publicKey.slice(0, 6)}...${publicKey.slice(-4)}`;
}

export type {
  AccountAssetSnapshot,
  AssetDescriptor,
  AssetReadFailureReason,
  TrustlineAuthorization,
};
export { StellarAssetReadError };
