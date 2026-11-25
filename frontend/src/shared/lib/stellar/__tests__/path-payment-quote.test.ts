import { Keypair } from "@stellar/stellar-sdk";
import {
  DEFAULT_PATH_SLIPPAGE_BPS,
  PathQuoteError,
  fetchBestStrictReceiveQuote,
  fetchStrictReceiveQuotes,
  isPathQuoteStale,
  selectBestPathQuote,
} from "@/shared/lib/stellar/path-payment-quote";
import type { AssetDescriptor } from "@/shared/lib/stellar/stellar-asset-reader";

const ISSUER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();
const OTHER_ISSUER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 11)).publicKey();
const XLM: AssetDescriptor = { kind: "native", code: "XLM" };
const USDC: AssetDescriptor = { kind: "credit", code: "USDC", issuer: ISSUER };

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
}

function record(sourceAmount: string, path: unknown[] = []) {
  return {
    source_amount: sourceAmount,
    source_asset_type: "native",
    destination_amount: "10.0000000",
    destination_asset_type: "credit_alphanum4",
    destination_asset_code: "USDC",
    destination_asset_issuer: ISSUER,
    path,
  };
}

const baseOptions = {
  horizonBaseUrl: "https://horizon.test/",
  sourceAssets: [XLM],
  destinationAsset: USDC,
  destinationAmount: "10.0000000",
  now: () => 1_000_000,
};

describe("strict-receive path quotes", () => {
  it("queries Horizon for the configured source assets and exact destination amount", async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      jsonResponse({ _embedded: { records: [record("12.0000000")] } }),
    );

    const quotes = await fetchStrictReceiveQuotes({ ...baseOptions, fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const url = new URL(fetchFn.mock.calls[0][0] as string);
    expect(`${url.origin}${url.pathname}`).toBe("https://horizon.test/paths/strict-receive");
    expect(url.searchParams.get("source_assets")).toBe("native");
    expect(url.searchParams.get("destination_asset_code")).toBe("USDC");
    expect(url.searchParams.get("destination_asset_issuer")).toBe(ISSUER);
    expect(url.searchParams.get("destination_amount")).toBe("10.0000000");
    expect(quotes).toHaveLength(1);
  });

  it("selects the cheapest quote and applies the slippage ceiling to sendMax", async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      jsonResponse({
        _embedded: {
          records: [
            record("12.0000000"),
            record("11.0000000", [
              {
                asset_type: "credit_alphanum4",
                asset_code: "EURC",
                asset_issuer: OTHER_ISSUER,
              },
            ]),
          ],
        },
      }),
    );

    const quotes = await fetchStrictReceiveQuotes({
      ...baseOptions,
      slippageBps: DEFAULT_PATH_SLIPPAGE_BPS,
      fetchFn,
    });
    const best = selectBestPathQuote(quotes);

    expect(best).not.toBeNull();
    expect(best?.sourceAmount).toBe("11.0000000");
    expect(best?.sendMax).toBe("11.1100000");
    expect(best?.path).toEqual([{ kind: "credit", code: "EURC", issuer: OTHER_ISSUER }]);
  });

  it("drops records whose destination or source asset is not the one requested", async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      jsonResponse({
        _embedded: {
          records: [
            {
              ...record("9.0000000"),
              destination_asset_issuer: OTHER_ISSUER,
            },
          ],
        },
      }),
    );

    await expect(fetchStrictReceiveQuotes({ ...baseOptions, fetchFn })).resolves.toEqual([]);
    await expect(
      fetchBestStrictReceiveQuote({ ...baseOptions, fetchFn }),
    ).rejects.toMatchObject({ reason: "no_path" } satisfies Partial<PathQuoteError>);
  });

  it("expires a quote at its stored deadline, independent of the transaction timeout", async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      jsonResponse({ _embedded: { records: [record("12.0000000")] } }),
    );
    const quotes = await fetchStrictReceiveQuotes({
      ...baseOptions,
      quoteTtlMs: 30_000,
      fetchFn,
    });
    const quote = selectBestPathQuote(quotes)!;

    expect(quote.expiresAt).toBe(1_030_000);
    expect(isPathQuoteStale(quote, 1_029_999)).toBe(false);
    expect(isPathQuoteStale(quote, 1_030_000)).toBe(true);
  });

  it("rejects malformed Horizon records instead of quoting them", async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      jsonResponse({
        _embedded: {
          records: [
            {
              ...record("12.0000000"),
              path: [{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "not-a-key" }],
            },
          ],
        },
      }),
    );

    await expect(fetchStrictReceiveQuotes({ ...baseOptions, fetchFn })).resolves.toEqual([]);
  });

  it("surfaces an unreachable Horizon as an unavailable quote, not an empty path", async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 503 } as Response);

    await expect(
      fetchBestStrictReceiveQuote({ ...baseOptions, fetchFn }),
    ).rejects.toMatchObject({ reason: "unavailable" } satisfies Partial<PathQuoteError>);
  });
});
