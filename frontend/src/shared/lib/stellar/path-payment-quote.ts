/**
 * Strict-receive path quotes for funded arena joins (#1716).
 *
 * Horizon finds the cheapest path that delivers an exact destination amount,
 * but a quote is a point-in-time observation: the path can disappear before a
 * wallet signs. Every quote therefore carries its own expiry and the caller is
 * required to re-check it before building a transaction.
 *
 * The module deliberately uses an injectable `fetch` and zod validation rather
 * than trusting the Horizon SDK response object: a malformed or swapped record
 * must never become a wallet prompt.
 */

import { Asset, StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import {
  amountToStroops,
  stroopsToAmount,
  type AssetDescriptor,
} from "@/shared/lib/stellar/stellar-asset-reader";

/** 1%: enough to absorb normal order-book movement without hiding a bad quote. */
export const DEFAULT_PATH_SLIPPAGE_BPS = 100;
/** Horizon quotes are short-lived; a stale quote is refreshed, never reused. */
export const DEFAULT_PATH_QUOTE_TTL_MS = 30_000;
const MAX_PATH_ASSETS = 10;

const ASSET_CODE = /^[A-Z0-9]{1,12}$/;
const DECIMAL_AMOUNT = /^\d+(\.\d{1,7})?$/;

export type PathQuoteErrorReason =
  | "no_path"
  | "unavailable"
  | "malformed_response"
  | "stale"
  | "invalid_request";

export class PathQuoteError extends Error {
  readonly reason: PathQuoteErrorReason;

  constructor(reason: PathQuoteErrorReason, message: string) {
    super(message);
    this.name = "PathQuoteError";
    this.reason = reason;
  }
}

export const AssetDescriptorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("native"), code: z.literal("XLM") }),
  z.object({
    kind: z.literal("credit"),
    code: z.string().regex(ASSET_CODE),
    issuer: z.string().refine((value) => StrKey.isValidEd25519PublicKey(value)),
  }),
]);

const PositiveAmountSchema = z
  .string()
  .regex(DECIMAL_AMOUNT)
  .refine((value) => amountToStroops(value) > 0n, {
    message: "amount must be greater than zero",
  });

export const PathQuoteSchema = z.object({
  sourceAsset: AssetDescriptorSchema,
  destinationAsset: AssetDescriptorSchema,
  sourceAmount: PositiveAmountSchema,
  destinationAmount: PositiveAmountSchema,
  sendMax: PositiveAmountSchema,
  path: z.array(AssetDescriptorSchema).max(MAX_PATH_ASSETS),
  slippageBps: z.number().int().min(0).max(10_000),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});

export type PathQuote = z.infer<typeof PathQuoteSchema>;

const HorizonPathAssetSchema = z.object({
  asset_type: z.string().min(1),
  asset_code: z.string().nullish(),
  asset_issuer: z.string().nullish(),
});

const HorizonPaymentPathRecordSchema = z.object({
  path: z.array(HorizonPathAssetSchema),
  source_amount: PositiveAmountSchema,
  source_asset_type: z.string().min(1),
  source_asset_code: z.string().nullish(),
  source_asset_issuer: z.string().nullish(),
  destination_amount: PositiveAmountSchema,
  destination_asset_type: z.string().min(1),
  destination_asset_code: z.string().nullish(),
  destination_asset_issuer: z.string().nullish(),
});

const StrictReceivePageSchema = z.object({
  _embedded: z.object({
    records: z.array(HorizonPaymentPathRecordSchema),
  }),
});

/** True when two descriptors identify the same on-chain asset. */
export function assetDescriptorEquals(
  left: AssetDescriptor,
  right: AssetDescriptor,
): boolean {
  if (left.kind !== right.kind || left.code !== right.code) return false;
  if (left.kind === "native") return true;
  return (
    right.kind === "credit" &&
    left.issuer.toLowerCase() === right.issuer.toLowerCase()
  );
}

/** Convert the app's asset descriptor into the SDK asset used by operations. */
export function sdkAssetFromDescriptor(descriptor: AssetDescriptor): Asset {
  const parsed = AssetDescriptorSchema.parse(descriptor);
  return parsed.kind === "native"
    ? Asset.native()
    : new Asset(parsed.code, parsed.issuer);
}

/** Horizon's `source_assets` query encoding. */
export function encodeSourceAssets(sourceAssets: readonly AssetDescriptor[]): string {
  if (sourceAssets.length === 0) {
    throw new PathQuoteError("invalid_request", "No source assets were provided");
  }
  return sourceAssets
    .map((asset) => {
      const parsed = AssetDescriptorSchema.parse(asset);
      return parsed.kind === "native"
        ? "native"
        : `${parsed.code}:${parsed.issuer}`;
    })
    .join(",");
}

function horizonAssetQuery(asset: AssetDescriptor): Record<string, string> {
  const parsed = AssetDescriptorSchema.parse(asset);
  if (parsed.kind === "native") return { destination_asset_type: "native" };
  return {
    destination_asset_type:
      parsed.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
    destination_asset_code: parsed.code,
    destination_asset_issuer: parsed.issuer,
  };
}

function descriptorFromHorizonAsset(value: z.infer<typeof HorizonPathAssetSchema>): AssetDescriptor | null {
  if (value.asset_type === "native") return { kind: "native", code: "XLM" };
  if (
    value.asset_type !== "credit_alphanum4" &&
    value.asset_type !== "credit_alphanum12"
  ) {
    return null;
  }
  if (
    typeof value.asset_code !== "string" ||
    !ASSET_CODE.test(value.asset_code) ||
    typeof value.asset_issuer !== "string" ||
    !StrKey.isValidEd25519PublicKey(value.asset_issuer)
  ) {
    return null;
  }
  return {
    kind: "credit",
    code: value.asset_code,
    issuer: value.asset_issuer,
  };
}

/** Ceiling division keeps `sendMax` from rounding below the quoted source amount. */
function sendMaxStroops(sourceAmount: string, slippageBps: number): bigint {
  const base = amountToStroops(sourceAmount);
  const numerator = base * BigInt(10_000 + slippageBps);
  return (numerator + 9_999n) / 10_000n;
}

/** True once the quote may no longer reflect the order book. */
export function isPathQuoteStale(quote: PathQuote, now = Date.now()): boolean {
  return !Number.isFinite(now) || now >= quote.expiresAt;
}

/** Reject a quote that has passed its expiry before it reaches a wallet. */
export function assertFreshPathQuote(quote: PathQuote, now = Date.now()): void {
  if (isPathQuoteStale(quote, now)) {
    throw new PathQuoteError(
      "stale",
      "This payment quote has expired. Refresh it before signing.",
    );
  }
}

export interface StrictReceiveQuoteOptions {
  horizonBaseUrl: string;
  sourceAssets: readonly AssetDescriptor[];
  destinationAsset: AssetDescriptor;
  destinationAmount: string;
  slippageBps?: number;
  quoteTtlMs?: number;
  now?: () => number;
  fetchFn?: typeof fetch;
}

/**
 * Fetch and validate every strict-receive path Horizon can find. Records that
 * do not match the requested source set or destination are dropped rather than
 * being surfaced to the user.
 */
export async function fetchStrictReceiveQuotes(
  options: StrictReceiveQuoteOptions,
): Promise<PathQuote[]> {
  const slippageBps = options.slippageBps ?? DEFAULT_PATH_SLIPPAGE_BPS;
  const quoteTtlMs = options.quoteTtlMs ?? DEFAULT_PATH_QUOTE_TTL_MS;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new PathQuoteError("invalid_request", "Slippage must be between 0 and 10000 bps");
  }
  if (!Number.isFinite(quoteTtlMs) || quoteTtlMs <= 0) {
    throw new PathQuoteError("invalid_request", "Quote TTL must be positive");
  }

  const destinationAmount = PositiveAmountSchema.parse(options.destinationAmount);
  const sourceAssetsParam = encodeSourceAssets(options.sourceAssets);
  const params = new URLSearchParams({
    source_assets: sourceAssetsParam,
    destination_amount: destinationAmount,
    ...horizonAssetQuery(options.destinationAsset),
  });
  const base = options.horizonBaseUrl.replace(/\/+$/, "");
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(`${base}/paths/strict-receive?${params}`, {
    headers: { Accept: "application/json" },
  });
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new PathQuoteError(
      "unavailable",
      `Horizon strict-receive quoting failed (${response.status})`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new PathQuoteError("malformed_response", "Horizon returned invalid JSON");
  }
  const page = StrictReceivePageSchema.safeParse(payload);
  if (!page.success) {
    throw new PathQuoteError(
      "malformed_response",
      "Horizon returned an unrecognised strict-receive path record",
    );
  }

  const destinationStroops = amountToStroops(destinationAmount);
  const now = (options.now ?? Date.now)();
  const quotes: PathQuote[] = [];

  for (const record of page.data._embedded.records) {
    if (amountToStroops(record.destination_amount) !== destinationStroops) continue;

    const sourceAsset = descriptorFromHorizonAsset({
      asset_type: record.source_asset_type,
      asset_code: record.source_asset_code,
      asset_issuer: record.source_asset_issuer,
    });
    const destination = descriptorFromHorizonAsset({
      asset_type: record.destination_asset_type,
      asset_code: record.destination_asset_code,
      asset_issuer: record.destination_asset_issuer,
    });
    if (
      sourceAsset === null ||
      destination === null ||
      !assetDescriptorEquals(destination, options.destinationAsset) ||
      !options.sourceAssets.some((asset) => assetDescriptorEquals(asset, sourceAsset))
    ) {
      continue;
    }

    const path: AssetDescriptor[] = [];
    let malformedPath = false;
    for (const entry of record.path) {
      const asset = descriptorFromHorizonAsset(entry);
      if (asset === null) {
        malformedPath = true;
        break;
      }
      path.push(asset);
    }
    if (malformedPath) continue;

    quotes.push(
      PathQuoteSchema.parse({
        sourceAsset,
        destinationAsset: options.destinationAsset,
        sourceAmount: record.source_amount,
        destinationAmount: record.destination_amount,
        sendMax: stroopsToAmount(sendMaxStroops(record.source_amount, slippageBps)),
        path,
        slippageBps,
        createdAt: now,
        expiresAt: now + quoteTtlMs,
      }),
    );
  }

  return quotes.sort((a, b) => {
    const byAmount = amountToStroops(a.sourceAmount) - amountToStroops(b.sourceAmount);
    return byAmount === 0n ? a.path.length - b.path.length : byAmount > 0n ? 1 : -1;
  });
}

/** Choose the cheapest valid quote; `null` means "no path right now". */
export function selectBestPathQuote(quotes: readonly PathQuote[]): PathQuote | null {
  return quotes.length === 0 ? null : quotes[0] ?? null;
}

/**
 * Convenience wrapper used by the join flow. Unlike {@link fetchStrictReceiveQuotes}
 * it turns an empty result into a typed error, which lets the UI distinguish
 * "no path" from "Horizon is down".
 */
export async function fetchBestStrictReceiveQuote(
  options: StrictReceiveQuoteOptions,
): Promise<PathQuote> {
  const quotes = await fetchStrictReceiveQuotes(options);
  const best = selectBestPathQuote(quotes);
  if (best === null) {
    throw new PathQuoteError("no_path", "No payment path can fund this entry right now");
  }
  return best;
}
