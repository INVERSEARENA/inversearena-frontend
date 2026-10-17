/**
 * Asset-readiness gate tests (#1487).
 *
 * The behaviour these lock down is the sequence, not the arithmetic (which
 * `asset-readiness.test.ts` covers). The failure this exists to prevent is a
 * gate that reports `ready` before the account actually can receive the
 * asset, because the user then signs a transaction that cannot settle.
 *
 * @module
 */

import { renderHook, act, waitFor } from "@testing-library/react";
import { useAssetReadinessGate } from "@/features/asset-readiness/useAssetReadinessGate";
import {
  buildChangeTrustTransaction,
  submitSignedTransaction,
} from "@/shared-d/utils/stellar-transactions";
import {
  setAssetReadinessSink,
  type AssetReadinessEvent,
} from "@/shared-d/telemetry/asset-readiness";

const HOLDER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const ISSUER = "GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL";

const wallet = {
  publicKey: HOLDER as string | null,
  address: HOLDER as string | null,
  isConnected: true,
  network: "TESTNET",
  signTransaction: jest.fn().mockResolvedValue("signed-xdr"),
};

jest.mock("@/features/wallet/useWallet", () => ({
  useWallet: () => wallet,
}));

jest.mock("@/shared-d/utils/stellar-transactions", () => ({
  buildChangeTrustTransaction: jest.fn(),
  submitSignedTransaction: jest.fn(),
}));

jest.mock("@/shared-d/security/policy", () => ({
  evaluateSigningRequest: jest.fn(),
  SigningPolicyError: class SigningPolicyError extends Error {},
}));

const issuers = { USDC: ISSUER };

/**
 * Horizon payload with a trustline whose limit is `limit`.
 *
 * `limit` is a *decimal* string, matching Horizon. Passing a raw stroop count
 * here looks plausible and is silently off by 10^7 — a "0.1 USDC" limit written
 * as `"1000000"` reads as 10,000,000 USDC and the account looks funded.
 */
function accountPayload(limit: string) {
  return {
    id: HOLDER,
    account_id: HOLDER,
    sequence: "12345",
    subentry_count: 1,
    balances: [
      { asset_type: "native", balance: "100.0000000" },
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: ISSUER,
        balance: "0.0000000",
        limit,
        is_authorized: true,
        is_authorized_to_maintain_liabilities: true,
      },
    ],
  };
}

function issuerPayload(flags: Record<string, unknown> = {}) {
  return {
    id: ISSUER,
    account_id: ISSUER,
    sequence: "1",
    subentry_count: 0,
    flags: { auth_required: false, auth_revocable: false, clawback_enabled: false, ...flags },
  };
}

function stubFetch(
  account: unknown,
  issuer: unknown = issuerPayload(),
): jest.Mock {
  return jest.fn().mockImplementation((url: string) => {
    if (url.includes("/accounts/")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(url.includes(HOLDER) ? account : issuer),
      });
    }
    if (url.includes("/ledgers")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            records: [{ base_reserve_in_stroops: 5_000_000, base_fee_in_stroops: 100 }],
          }),
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });
}

function renderGate(amountStroops = 10_000_000n) {
  return renderHook(() =>
    useAssetReadinessGate({
      assetCode: "USDC",
      amountStroops,
      entryPoint: "stake",
      enabled: true,
      issuers,
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  wallet.publicKey = HOLDER;
  wallet.address = HOLDER;
  wallet.isConnected = true;
  wallet.signTransaction = jest.fn().mockResolvedValue("signed-xdr");
  (buildChangeTrustTransaction as jest.Mock).mockResolvedValue({
    toXDR: () => "trustline-xdr",
  });
  (submitSignedTransaction as jest.Mock).mockResolvedValue({ txHash: "abc" });
  global.fetch = stubFetch(accountPayload("10000.0000000"));
  setAssetReadinessSink(null);
});

afterEach(() => {
  setAssetReadinessSink(null);
});

describe("useAssetReadinessGate — ready", () => {
  it("reports ready when the trustline has headroom", async () => {
    const { result } = renderGate(10_000_000n);

    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.canProceed).toBe(true);
    expect(result.current.remediation).toBeNull();
  });

  it("resolves native XLM without any network read", async () => {
    global.fetch = jest.fn();
    const { result } = renderHook(() =>
      useAssetReadinessGate({
        assetCode: "XLM",
        amountStroops: 10n,
        entryPoint: "stake",
        enabled: true,
        issuers,
      }),
    );

    // Synchronous: a native asset has no trustline to check, so gating a
    // button on a Horizon round-trip would only add a way to be wrongly
    // disabled.
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("useAssetReadinessGate — blocked", () => {
  it("offers a remediation when the trustline limit is too low", async () => {
    global.fetch = stubFetch(accountPayload("0.1000000"));
    const { result } = renderGate(50_000_000n);

    await waitFor(() => expect(result.current.phase).toBe("remediation_offered"));
    expect(result.current.canProceed).toBe(false);
    expect(result.current.remediation?.limit).toBeTruthy();
    // The copy must name the issuer, because that is the detail a user needs
    // in order to decide whether they trust the asset at all.
    expect(result.current.remediation?.issuer).toBe(ISSUER);
  });

  it("refuses to guess an issuer when the asset is unconfigured", async () => {
    const { result } = renderHook(() =>
      useAssetReadinessGate({
        assetCode: "EURC",
        amountStroops: 10n,
        entryPoint: "join",
        enabled: true,
        issuers,
      }),
    );

    await waitFor(() => expect(result.current.phase).toBe("blocked"));
    expect(result.current.message).toContain("NEXT_PUBLIC_EURC_ISSUER");
    expect(result.current.canProceed).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("blocks rather than proceeding when the account cannot be read", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    });
    const { result } = renderGate();

    await waitFor(() => expect(result.current.phase).toBe("blocked"));
    expect(result.current.canProceed).toBe(false);
    // A read failure is retryable, and the UI must offer that.
    expect(result.current.canRetry).toBe(true);
  });

  it("blocks when no account is connected", async () => {
    wallet.publicKey = null;
    wallet.address = null;
    const { result } = renderGate();

    await waitFor(() => expect(result.current.phase).toBe("blocked"));
    expect(result.current.canProceed).toBe(false);
  });
});

describe("useAssetReadinessGate — remediation", () => {
  it("builds, signs and submits, then re-reads before claiming ready", async () => {
    global.fetch = stubFetch(accountPayload("0.1000000"));
    const { result } = renderGate(50_000_000n);
    await waitFor(() => expect(result.current.phase).toBe("remediation_offered"));

    // The account still has a low limit at the moment the user starts.
    expect(result.current.canProceed).toBe(false);

    // After signing, the server begins reporting headroom.
    global.fetch = stubFetch(accountPayload("10000.0000000"));
    await act(async () => {
      await result.current.remediate();
    });

    expect(buildChangeTrustTransaction).toHaveBeenCalledWith(
      HOLDER,
      { code: "USDC", issuer: ISSUER },
      expect.any(String),
    );
    expect(wallet.signTransaction).toHaveBeenCalledWith("trustline-xdr");
    expect(submitSignedTransaction).toHaveBeenCalledWith("signed-xdr");

    // Re-read, not assumed: ready only after a fresh read agrees.
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.canProceed).toBe(true);
  });

  it("does not report ready when submission fails", async () => {
    global.fetch = stubFetch(accountPayload("0.1000000"));
    (submitSignedTransaction as jest.Mock).mockRejectedValue(new Error("tx_failed"));

    const { result } = renderGate(50_000_000n);
    await waitFor(() => expect(result.current.phase).toBe("remediation_offered"));

    await act(async () => {
      await result.current.remediate();
    });

    // The user must be left looking at the failure, not at an enabled button.
    expect(result.current.canProceed).toBe(false);
    expect(result.current.phase).toBe("remediation_offered");
    expect(result.current.message).toContain("tx_failed");
  });

  it("does nothing when there is no remediation to apply", async () => {
    const { result } = renderGate();
    await waitFor(() => expect(result.current.phase).toBe("ready"));

    await act(async () => {
      await result.current.remediate();
    });

    expect(buildChangeTrustTransaction).not.toHaveBeenCalled();
  });
});

describe("useAssetReadinessGate — telemetry", () => {
  it("records the outcome with a masked account, never the full key", async () => {
    const events: AssetReadinessEvent[] = [];
    setAssetReadinessSink((event) => events.push(event));

    renderGate();
    await waitFor(() => expect(events).toHaveLength(1));

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.name).toBe("asset_readiness");
    expect(event?.state).toBe("ready");
    expect(event?.entryPoint).toBe("stake");
    expect(event?.canProceed).toBe(true);
    // The point of the assertion: the raw key must not be present.
    expect(event?.accountRef).not.toBe(HOLDER);
    expect(event?.accountRef).toMatch(/\.\.\./);
  });

  it("survives a telemetry sink that throws", async () => {
    setAssetReadinessSink(() => {
      throw new Error("analytics down");
    });

    const { result } = renderGate();

    // An analytics regression must not become a blocked wallet action.
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.canProceed).toBe(true);
  });
});
