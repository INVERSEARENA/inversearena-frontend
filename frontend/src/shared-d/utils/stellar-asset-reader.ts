/**
 * Account asset snapshot reader for the asset-readiness preflight (#1487).
 *
 * Why this is a separate module from {@link file://./stellar-balance.ts}:
 * `fetchAssetBalance` answers "how much of XLM/USDC does this wallet hold" and
 * deliberately collapses every "not held" case to `0`. A preflight cannot use
 * that — it must distinguish a *missing trustline* (needs a `changeTrust`)
 * from a *zero balance* (needs a deposit), and it needs the trustline `limit`
 * and the account's reserve headroom to tell "insufficient limit" apart from
 * "insufficient reserve". `fetchWalletBalance` also uses `Promise.all`, so one
 * failed lookup rejects the whole wallet read and yields no partial state.
 *
 * Everything here is read-only and every network call is injectable so the
 * classification can be unit-tested against recorded Horizon payloads.
 *
 * Protocol facts this module depends on (verified against Horizon v28 /
 * stellar-core 29, protocol 28):
 *
 *  - Horizon's `GET /accounts/{id}` exposes `subentry_count`, `num_sponsoring`
 *    and `num_sponsored`, but **not** a `min_balance` field. The minimum
 *    balance has to be computed as
 *    `(2 + subentry_count + num_sponsoring - num_sponsored) * baseReserve`
 *    (the `- numSponsored` term exists because sponsored entries are paid for
 *    by the sponsor). Data entries, trustlines, offers and pool shares are all
 *    already counted inside `subentry_count` — they must not be added again.
 *  - The base reserve is a *ledger* property. Read it from
 *    `GET /ledgers?order=desc&limit=1` → `base_reserve_in_stroops`; the
 *    `/` root endpoint does not carry it.
 *  - `is_clawback_enabled` is only serialised when it is `true` (Horizon
 *    marshals it with `omitempty` behind a `*bool`). Absence means `false`;
 *    comparing `=== false` would misreport every issuer.
 *  - Native balances carry no `limit` and no authorization flags at all.
 *  - `limit` is a decimal *amount* string, not an integer, and a balance may
 *    legitimately be negative (that is what a liability is). All arithmetic
 *    here is therefore done in stroops (`bigint`), never in `number`.
 *
 * @module
 */

import { z } from "zod";
import { StellarPublicKeySchema } from "@/shared-d/utils/security-validation";
import { stellarConfig } from "@/lib/stellarConfig";

/** Stroops per unit. Stellar amounts carry 7 decimal places. */
export const STROOPS_PER_UNIT = 10_000_000n;

/**
 * Base reserve of 0.5 XLM is protocol-constant, but it is *read from the
 * ledger* rather than hardcoded so a future network change cannot silently
 * desynchronise the preflight's reserve arithmetic. This is the fallback used
 * when the ledger read fails and the caller asked for a degraded result.
 */
export const FALLBACK_BASE_RESERVE_STROOPS = 5_000_000n;

/** Issuer account flags, per the Stellar account flags registry. */
export interface IssuerFlags {
  authRequired: boolean;
  authRevocable: boolean;
  authImmutable: boolean;
  authClawbackEnabled: boolean;
}

const ISSUER_FLAG_AUTH_REQUIRED = 1;
const ISSUER_FLAG_AUTH_REVOCABLE = 2;
const ISSUER_FLAG_AUTH_IMMUTABLE = 4;
const ISSUER_FLAG_AUTH_CLAWBACK_ENABLED = 8;

/**
 * Trustline authorization as reported by Horizon.
 *
 * - `full` — `is_authorized === true`. The holder may increase and decrease.
 * - `maintain_only` — partially deauthorized (`AUTHORIZED_TO_MAINTAIN_LIABILITIES`).
 *   The holder may reduce the balance and withdraw, but may not increase it,
 *   so receiving an asset is still impossible.
 * - `deauthorized` — fully revoked. The balance is frozen; only
 *   `AUTHORIZED_TO_MAINTAIN_LIABILITIES` would allow a reduction.
 *
 * Note the ordering: `is_authorized_to_maintain_liabilities` is `true` for a
 * fully authorized trustline too (Horizon defaults it to the value of
 * `is_authorized` for backwards compatibility), so it must never be tested
 * on its own to decide "partially deauthorized".
 */
export type TrustlineAuthorization = "full" | "maintain_only" | "deauthorized";

/** Identity of the asset a preflight is being asked about. */
export type AssetDescriptor =
  | { readonly kind: "native"; readonly code: "XLM" }
  | { readonly kind: "credit"; readonly code: string; readonly issuer: string };

/** One entry of a Horizon account's `balances[]`, already normalised. */
export interface AssetBalance {
  assetType: string;
  assetCode: string | null;
  assetIssuer: string | null;
  /** Decimal amount string exactly as Horizon reported it. */
  balance: string;
  /** `null` for native and for liquidity-pool shares. */
  limit: string | null;
  buyingLiabilities: string;
  sellingLiabilities: string;
  authorization: TrustlineAuthorization;
  clawbackEnabled: boolean;
  lastModifiedLedger: number | null;
  lastModifiedTime: string | null;
  sponsor: string | null;
  /** True for entries that are tradable/holdable assets (credit alphanum). */
  isCredit: boolean;
}

/** Everything the preflight needs from one account read. */
export interface AccountAssetSnapshot {
  publicKey: string;
  /** Base fee the network last charged, in stroops. `null` when unknown. */
  baseFeeStroops: bigint | null;
  baseReserveStroops: bigint;
  /** True when `baseReserveStroops` is the protocol fallback, not a ledger read. */
  baseReserveFromLedger: boolean;
  subentryCount: number;
  numSponsoring: number;
  numSponsored: number;
  /** `(2 + subentry + sponsoring - sponsored) * baseReserve`, in stroops. */
  minimumBalanceStroops: bigint;
  nativeBalanceStroops: bigint;
  nativeSellingLiabilitiesStroops: bigint;
  /**
   * XLM the account could actually commit to a new subentry: its native
   * balance minus native selling liabilities, compared against the minimum
   * balance it already owes.
   */
  availableAboveReserveStroops: bigint;
  /** Headroom for one more subentry: `available - minimumBalance`. */
  subentryHeadroomStroops: bigint;
  /** Cost of adding exactly one more subentry at the current base reserve. */
  subentryCostStroops: bigint;
  balances: readonly AssetBalance[];
  lastModifiedLedger: number | null;
  /** The issuer's own flags; `null` when the asset is native or unknown. */
  issuerFlags: IssuerFlags | null;
  issuerHomeDomain: string | null;
  issuerExists: boolean | null;
  /** Epoch millis the snapshot was assembled, for freshness reporting. */
  observedAtMs: number;
}

/** Machine-readable reasons an account/ledger read can fail. */
export type AssetReadFailureReason =
  | "invalid_public_key"
  | "account_not_found"
  | "http_error"
  | "rate_limited"
  | "network_error"
  | "malformed_response"
  | "invalid_ledger_response"
  | "invalid_amount";

/**
 * Raised when an account or ledger read could not be completed.
 *
 * Distinct from "the account holds nothing": callers must render a retry
 * state rather than defaulting to a zero balance or a zero reserve.
 */
export class StellarAssetReadError extends Error {
  readonly reason: AssetReadFailureReason;
  readonly status: number | null;

  constructor(
    reason: AssetReadFailureReason,
    message: string,
    options?: { cause?: unknown; status?: number },
  ) {
    super(message);
    this.name = "StellarAssetReadError";
    this.reason = reason;
    this.status = options?.status ?? null;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export type AssetFetchFn = typeof fetch;

export interface AssetReadDeps {
  horizonUrl?: string;
  fetchFn?: AssetFetchFn;
  /** Injected in tests; defaults to `Date.now()`. */
  now?: () => number;
  /** Injected in tests; defaults to the protocol fallback reserve. */
  fallbackBaseReserveStroops?: bigint;
}

/* -------------------------------------------------------------------------- */
/* Amount helpers                                                              */
/* -------------------------------------------------------------------------- */

const DECIMAL_AMOUNT = /^(-?)(\d+)(?:\.(\d{1,7}))?$/;

/**
 * Convert a Stellar decimal amount string to stroops.
 *
 * Strict on purpose: a Horizon payload that is not a well-formed amount with
 * at most 7 decimal places is malformed data, and silently coercing it to `0`
 * would turn a parse failure into "you have no balance" — the exact class of
 * bug this preflight exists to prevent.
 *
 * @throws {StellarAssetReadError} with reason `malformed_response`.
 */
export function amountToStroops(amount: string): bigint {
  const match = DECIMAL_AMOUNT.exec(amount.trim());
  if (!match) {
    throw new StellarAssetReadError(
      "malformed_response",
      `Malformed Stellar amount: ${JSON.stringify(amount)}`,
    );
  }
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";
  const value =
    BigInt(whole) * STROOPS_PER_UNIT + BigInt(fraction.padEnd(7, "0"));
  return match[1] === "-" ? -value : value;
}

/** Format stroops back to a 7-decimal amount string. */
export function stroopsToAmount(stroops: bigint): string {
  const negative = stroops < 0n;
  const magnitude = negative ? -stroops : stroops;
  const whole = magnitude / STROOPS_PER_UNIT;
  const fraction = (magnitude % STROOPS_PER_UNIT).toString().padStart(7, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

/**
 * Round an amount up to whole stroops.
 *
 * Used for reserve shortfalls: telling a user they are `0.0000001 XLM` short
 * is noise, and rounding down would claim a shortfall that does not exist.
 */
export function ceilingStroops(stroops: bigint): bigint {
  return stroops > 0n ? stroops : 0n;
}

/**
 * Convert a display-unit amount from the API to stroops.
 *
 * Floors, deliberately, because this is the same conversion the transaction
 * builders in `stellar-transactions.ts` apply. A preflight that rounded
 * differently from the builder it gates would either block accounts that
 * could in fact transact, or wave through ones that cannot — so the rounding
 * direction has to match, and the network's own rule is to discard
 * precision.
 */
export function displayAmountToStroops(amount: number): bigint {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new StellarAssetReadError(
      "invalid_amount",
      `Cannot convert non-finite or negative display amount: ${String(amount)}`,
    );
  }
  return BigInt(Math.floor(amount * Number(STROOPS_PER_UNIT)));
}

/* -------------------------------------------------------------------------- */
/* Horizon payload schemas                                                     */
/* -------------------------------------------------------------------------- */

const HorizonBalanceSchema = z
  .object({
    asset_type: z.string().min(1),
    asset_code: z.string().nullish(),
    asset_issuer: z.string().nullish(),
    balance: z.string().min(1),
    limit: z.string().nullish(),
    buying_liabilities: z.string().nullish(),
    selling_liabilities: z.string().nullish(),
    is_authorized: z.boolean().nullish(),
    is_authorized_to_maintain_liabilities: z.boolean().nullish(),
    is_clawback_enabled: z.boolean().nullish(),
    last_modified_ledger: z.number().int().nullish(),
    last_modified_time: z.string().nullish(),
    sponsor: z.string().nullish(),
  })
  .passthrough();

const HorizonAccountSchema = z
  .object({
    account_id: z.string().min(1),
    sequence: z.union([z.string(), z.number()]),
    subentry_count: z.number().int().nonnegative(),
    num_sponsoring: z.number().int().nonnegative().nullish(),
    num_sponsored: z.number().int().nonnegative().nullish(),
    last_modified_ledger: z.number().int().nullish(),
    balances: z.array(HorizonBalanceSchema),
    flags: z
      .object({
        auth_required: z.boolean().nullish(),
        auth_revocable: z.boolean().nullish(),
        auth_immutable: z.boolean().nullish(),
        auth_clawback_enabled: z.boolean().nullish(),
      })
      .passthrough()
      .nullish(),
    home_domain: z.string().nullish(),
  })
  .passthrough();

const HorizonLedgerRecordSchema = z
  .object({
    base_reserve_in_stroops: z.union([z.number(), z.string()]),
    base_fee_in_stroops: z.union([z.number(), z.string()]).nullish(),
    sequence: z.number().int().nullish(),
  })
  .passthrough();

const HorizonLedgerPageSchema = z
  .object({
    records: z.array(HorizonLedgerRecordSchema).min(1),
  })
  .passthrough();

/* -------------------------------------------------------------------------- */
/* Pure classification helpers                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Derive trustline authorization from Horizon's two authorization booleans.
 *
 * `is_authorized_to_maintain_liabilities` must be read *second*: Horizon sets
 * it to `true` for fully authorized trustlines as well, so testing it first
 * would classify every healthy trustline as partially deauthorized.
 */
export function classifyTrustlineAuthorization(flags: {
  is_authorized?: boolean | null | undefined;
  is_authorized_to_maintain_liabilities?: boolean | null | undefined;
}): TrustlineAuthorization {
  if (flags.is_authorized === true) return "full";
  if (flags.is_authorized_to_maintain_liabilities === true) return "maintain_only";
  return "deauthorized";
}

/** Decode Horizon's issuer account flags bitfield. */
export function decodeIssuerFlags(flags: {
  auth_required?: boolean | null | undefined;
  auth_revocable?: boolean | null | undefined;
  auth_immutable?: boolean | null | undefined;
  auth_clawback_enabled?: boolean | null | undefined;
}): IssuerFlags {
  return {
    authRequired: flags.auth_required === true,
    authRevocable: flags.auth_revocable === true,
    authImmutable: flags.auth_immutable === true,
    authClawbackEnabled: flags.auth_clawback_enabled === true,
  };
}

/**
 * Credit-alphanum asset types Horizon uses for holdable balances.
 * `liquidity_pool_shares` has a `limit`-less balance of a different shape and
 * is deliberately excluded.
 */
const CREDIT_ASSET_TYPES = new Set([
  "credit_alphanum4",
  "credit_alphanum12",
]);

export function isCreditAssetType(assetType: string): boolean {
  return CREDIT_ASSET_TYPES.has(assetType);
}

/**
 * Find a holdable credit balance for an exact `(code, issuer)` pair.
 *
 * Matching on the issuer is not optional: asset codes are namespaced by
 * issuer, so a code-only match would happily resolve a *different* issuer's
 * token and report the wallet as ready for an asset it cannot receive.
 */
export function findCreditBalance(
  balances: readonly AssetBalance[],
  code: string,
  issuer: string,
): AssetBalance | null {
  const wanted = code.trim().toUpperCase();
  return (
    balances.find(
      (balance) =>
        balance.isCredit &&
        balance.assetCode?.trim().toUpperCase() === wanted &&
        balance.assetIssuer === issuer,
    ) ?? null
  );
}

export function findNativeBalance(
  balances: readonly AssetBalance[],
): AssetBalance | null {
  return balances.find((balance) => balance.assetType === "native") ?? null;
}

/**
 * Remaining capacity on an existing trustline, in stroops.
 *
 * A trustline stays valid only while `balance >= selling_liabilities` and
 * `balance + buying_liabilities <= limit`, so the amount that can still be
 * *received* is `limit - balance - buying_liabilities`. A negative result means
 * the account is already over-committed and no new `changeTrust` that keeps the
 * limit can succeed.
 */
export function trustlineHeadroomStroops(balance: AssetBalance): bigint {
  const limit = balance.limit === null ? 0n : amountToStroops(balance.limit);
  return (
    limit -
    amountToStroops(balance.balance) -
    amountToStroops(balance.buyingLiabilities)
  );
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

function normalizeBalance(raw: z.infer<typeof HorizonBalanceSchema>): AssetBalance {
  return {
    assetType: raw.asset_type,
    assetCode: raw.asset_code ?? null,
    assetIssuer: raw.asset_issuer ?? null,
    balance: raw.balance,
    limit: raw.limit ?? null,
    buyingLiabilities: raw.buying_liabilities ?? "0.0000000",
    sellingLiabilities: raw.selling_liabilities ?? "0.0000000",
    authorization: classifyTrustlineAuthorization(raw),
    // `is_clawback_enabled` is omitted entirely when false — treat absence as
    // false rather than comparing against `false`.
    clawbackEnabled: raw.is_clawback_enabled === true,
    lastModifiedLedger: raw.last_modified_ledger ?? null,
    lastModifiedTime: raw.last_modified_time ?? null,
    sponsor: raw.sponsor ?? null,
    isCredit: isCreditAssetType(raw.asset_type),
  };
}

/**
 * Turn a validated account payload plus a base reserve into the snapshot the
 * preflight classifies. Pure, so the reserve arithmetic is unit-testable
 * without a network.
 */
export function buildAccountAssetSnapshot(params: {
  publicKey: string;
  account: z.infer<typeof HorizonAccountSchema>;
  baseReserveStroops: bigint;
  baseReserveFromLedger: boolean;
  baseFeeStroops: bigint | null;
  issuerFlags: IssuerFlags | null;
  issuerHomeDomain: string | null;
  issuerExists: boolean | null;
  observedAtMs: number;
}): AccountAssetSnapshot {
  const {
    publicKey,
    account,
    baseReserveStroops,
    baseReserveFromLedger,
    baseFeeStroops,
    issuerFlags,
    issuerHomeDomain,
    issuerExists,
    observedAtMs,
  } = params;

  const balances = account.balances.map(normalizeBalance);
  const subentryCount = account.subentry_count;
  const numSponsoring = account.num_sponsoring ?? 0;
  const numSponsored = account.num_sponsored ?? 0;

  // Trustlines, data entries, offers and pool shares are all already counted
  // inside `subentry_count`; adding them again would double-charge the caller.
  const minimumBalanceStroops =
    (2n + BigInt(subentryCount) + BigInt(numSponsoring) - BigInt(numSponsored)) *
    baseReserveStroops;

  const native = findNativeBalance(balances);
  const nativeBalanceStroops = native ? amountToStroops(native.balance) : 0n;
  const nativeSellingLiabilitiesStroops = native
    ? amountToStroops(native.sellingLiabilities)
    : 0n;

  // Native selling liabilities are XLM the account has already promised away,
  // so they are not available to fund a new subentry.
  const availableAboveReserveStroops =
    nativeBalanceStroops - nativeSellingLiabilitiesStroops - minimumBalanceStroops;

  return {
    publicKey,
    baseFeeStroops,
    baseReserveStroops,
    baseReserveFromLedger,
    subentryCount,
    numSponsoring,
    numSponsored,
    minimumBalanceStroops,
    nativeBalanceStroops,
    nativeSellingLiabilitiesStroops,
    availableAboveReserveStroops,
    subentryHeadroomStroops: availableAboveReserveStroops,
    subentryCostStroops: baseReserveStroops,
    balances,
    lastModifiedLedger: account.last_modified_ledger ?? null,
    issuerFlags,
    issuerHomeDomain,
    issuerExists,
    observedAtMs,
  };
}

/* -------------------------------------------------------------------------- */
/* Network reads                                                               */
/* -------------------------------------------------------------------------- */

async function readJson(
  url: string,
  fetchFn: AssetFetchFn,
  failure: (status: number) => StellarAssetReadError,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (error) {
    throw new StellarAssetReadError(
      "network_error",
      `Network error while reading ${url}`,
      { cause: error },
    );
  }
  if (!res.ok) {
    throw failure(res.status);
  }
  try {
    return await res.json();
  } catch (error) {
    throw new StellarAssetReadError(
      "malformed_response",
      `Malformed JSON in response from ${url}`,
      { cause: error },
    );
  }
}

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Read the current base reserve (and base fee) from the newest closed ledger.
 *
 * A failure here is non-fatal: the caller may fall back to the protocol
 * constant and mark the snapshot as degraded, because a slightly stale reserve
 * is better than refusing to preflight at all. Every other read failure is
 * fatal to the snapshot.
 */
async function readLedgerBaseReserve(
  horizonUrl: string,
  fetchFn: AssetFetchFn,
): Promise<{ baseReserveStroops: bigint; baseFeeStroops: bigint | null } | null> {
  const url = `${trimTrailingSlashes(horizonUrl)}/ledgers?order=desc&limit=1`;
  const raw = await readJson(
    url,
    fetchFn,
    (status) =>
      new StellarAssetReadError(
        status === 429 ? "rate_limited" : "invalid_ledger_response",
        `Horizon ledger read failed with HTTP ${status}`,
        { status },
      ),
  );
  const parsed = HorizonLedgerPageSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StellarAssetReadError(
      "invalid_ledger_response",
      "Unexpected Horizon ledger response shape",
      { cause: parsed.error },
    );
  }
  const record = parsed.data.records[0];
  if (!record) {
    throw new StellarAssetReadError(
      "invalid_ledger_response",
      "Horizon returned no ledger records",
    );
  }
  const baseReserve = BigInt(record.base_reserve_in_stroops);
  if (baseReserve <= 0n) {
    throw new StellarAssetReadError(
      "invalid_ledger_response",
      `Horizon reported a non-positive base reserve: ${baseReserve}`,
    );
  }
  const baseFee =
    record.base_fee_in_stroops === null || record.base_fee_in_stroops === undefined
      ? null
      : BigInt(record.base_fee_in_stroops);
  return { baseReserveStroops: baseReserve, baseFeeStroops: baseFee };
}

async function readAccountPayload(
  horizonUrl: string,
  publicKey: string,
  fetchFn: AssetFetchFn,
): Promise<z.infer<typeof HorizonAccountSchema>> {
  const url = `${trimTrailingSlashes(horizonUrl)}/accounts/${publicKey}`;
  const raw = await readJson(
    url,
    fetchFn,
    (status) =>
      new StellarAssetReadError(
        status === 404
          ? "account_not_found"
          : status === 429
            ? "rate_limited"
            : "http_error",
        `Horizon account read failed with HTTP ${status}`,
        { status },
      ),
  );
  const parsed = HorizonAccountSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StellarAssetReadError(
      "malformed_response",
      "Unexpected Horizon account response shape",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

/**
 * Read one account's asset state, plus the issuer's flags when an issuer is
 * supplied.
 *
 * The issuer read is a second round trip and is skipped entirely for native
 * assets. A missing issuer is *not* fatal — it is surfaced as
 * `issuerExists: false` so the preflight can report a typed
 * `issuer_not_found` state instead of a generic failure.
 */
export async function readAccountAssetSnapshot(
  publicKey: string,
  issuer: string | null,
  deps: AssetReadDeps = {},
): Promise<AccountAssetSnapshot> {
  const horizonUrl = trimTrailingSlashes(deps.horizonUrl ?? stellarConfig.horizonUrl);
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const fallbackReserve = deps.fallbackBaseReserveStroops ?? FALLBACK_BASE_RESERVE_STROOPS;

  let validatedPublicKey: string;
  try {
    validatedPublicKey = StellarPublicKeySchema.parse(publicKey);
  } catch (error) {
    throw new StellarAssetReadError(
      "invalid_public_key",
      "The connected account is not a valid Stellar public key",
      { cause: error },
    );
  }

  let validatedIssuer: string | null = null;
  if (issuer !== null) {
    try {
      validatedIssuer = StellarPublicKeySchema.parse(issuer);
    } catch (error) {
      throw new StellarAssetReadError(
        "invalid_public_key",
        "The configured asset issuer is not a valid Stellar public key",
        { cause: error },
      );
    }
  }

  const account = await readAccountPayload(horizonUrl, validatedPublicKey, fetchFn);

  let baseReserveStroops = fallbackReserve;
  let baseReserveFromLedger = false;
  let baseFeeStroops: bigint | null = null;
  try {
    const ledger = await readLedgerBaseReserve(horizonUrl, fetchFn);
    if (ledger) {
      baseReserveStroops = ledger.baseReserveStroops;
      baseReserveFromLedger = true;
      baseFeeStroops = ledger.baseFeeStroops;
    }
  } catch (error) {
    if (!(error instanceof StellarAssetReadError)) throw error;
    // Degrade to the protocol constant rather than failing the whole preflight.
  }

  let issuerFlags: IssuerFlags | null = null;
  let issuerHomeDomain: string | null = null;
  let issuerExists: boolean | null = null;
  if (validatedIssuer !== null) {
    try {
      const issuerAccount = await readAccountPayload(
        horizonUrl,
        validatedIssuer,
        fetchFn,
      );
      issuerExists = true;
      issuerFlags = decodeIssuerFlags(issuerAccount.flags ?? {});
      issuerHomeDomain = issuerAccount.home_domain ?? null;
    } catch (error) {
      if (!(error instanceof StellarAssetReadError)) throw error;
      if (error.reason === "account_not_found") {
        issuerExists = false;
      } else {
        // An unreachable issuer must not be reported as "issuer does not
        // exist" — that would be a lie the user could act on. Leave it unknown
        // and let the trustline state speak for itself.
        issuerExists = null;
      }
    }
  }

  return buildAccountAssetSnapshot({
    publicKey: validatedPublicKey,
    account,
    baseReserveStroops,
    baseReserveFromLedger,
    baseFeeStroops,
    issuerFlags,
    issuerHomeDomain,
    issuerExists,
    observedAtMs: now(),
  });
}
