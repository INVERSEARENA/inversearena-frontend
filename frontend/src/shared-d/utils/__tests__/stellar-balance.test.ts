/**
 * Regression tests for #1295.
 *
 * fetchAssetBalance used to return 0 both when a wallet genuinely held
 * nothing AND when the lookup failed (Horizon 5xx / rate-limit / network
 * error), logging only a console.error. A transient outage then made every
 * wallet look empty, silently blocking legitimate stakes behind a
 * misleading "Insufficient balance" error.
 *
 * It must now distinguish "confirmed zero" from "couldn't find out":
 *  - account holds nothing / not funded (404)  → 0
 *  - network error / 429 / 5xx / malformed body → throw StellarBalanceError
 */
import {
  StellarBalanceError,
  fetchAssetBalance,
  fetchWalletBalance,
} from "@/shared-d/utils/stellar-balance";

const PUBLIC_KEY = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

function horizonOk(balances: Array<Record<string, unknown>>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ sequence: "1", balances }),
  } as unknown as Response;
}

function horizonStatus(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
  } as unknown as Response;
}

describe("fetchAssetBalance (#1295)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns the parsed amount when the account holds the asset", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(horizonOk([{ asset_type: "native", balance: "123.4567890" }]));

    await expect(fetchAssetBalance(PUBLIC_KEY, "XLM")).resolves.toBeCloseTo(123.456789);
  });

  it("returns a confirmed 0 when the account exists but does not hold the asset", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(horizonOk([{ asset_type: "native", balance: "10.0" }]));

    await expect(fetchAssetBalance(PUBLIC_KEY, "USDC")).resolves.toBe(0);
  });

  it("returns a confirmed 0 on 404 (account not funded yet)", async () => {
    global.fetch = jest.fn().mockResolvedValue(horizonStatus(404));

    await expect(fetchAssetBalance(PUBLIC_KEY, "XLM")).resolves.toBe(0);
  });

  it("throws StellarBalanceError on a 5xx instead of reporting 0", async () => {
    global.fetch = jest.fn().mockResolvedValue(horizonStatus(503));

    await expect(fetchAssetBalance(PUBLIC_KEY, "XLM")).rejects.toBeInstanceOf(
      StellarBalanceError,
    );
  });

  it("throws StellarBalanceError on a 429 rate-limit instead of reporting 0", async () => {
    global.fetch = jest.fn().mockResolvedValue(horizonStatus(429));

    await expect(fetchAssetBalance(PUBLIC_KEY, "USDC")).rejects.toBeInstanceOf(
      StellarBalanceError,
    );
  });

  it("throws StellarBalanceError when the fetch itself rejects (network error)", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(fetchAssetBalance(PUBLIC_KEY, "XLM")).rejects.toBeInstanceOf(
      StellarBalanceError,
    );
  });
});

describe("fetchWalletBalance (#1295)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("resolves with both balances when every lookup succeeds", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(horizonOk([{ asset_type: "native", balance: "50.0" }]))
      .mockResolvedValueOnce(
        horizonOk([{ asset_type: "credit_alphanum4", asset_code: "USDC", balance: "12.5" }]),
      );

    await expect(fetchWalletBalance(PUBLIC_KEY)).resolves.toEqual({ xlm: 50, usdc: 12.5 });
  });

  it("rejects (does not default to zero) when one lookup fails", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(horizonOk([{ asset_type: "native", balance: "50.0" }]))
      .mockResolvedValueOnce(horizonStatus(503));

    await expect(fetchWalletBalance(PUBLIC_KEY)).rejects.toBeInstanceOf(StellarBalanceError);
  });
});
