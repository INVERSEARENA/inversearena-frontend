/**
 * Asset-readiness preflight tests (#1487).
 *
 * Two layers, both network-free:
 *
 *   1. `buildAccountAssetSnapshot` + `classifyAssetReadiness` — the reserve and
 *      limit arithmetic, driven from recorded Horizon payloads. The acceptance
 *      criteria list specific edge cases (liabilities consuming the limit,
 *      reserve changes, revoked authorization) that are only checkable as pure
 *      functions over a snapshot.
 *   2. `preflightAssetReadiness` — the network-facing wrapper, driven with an
 *      injected `fetch`, covering RPC failure and stale/malformed responses.
 *
 * The state machine is the point: a boolean-plus-message design cannot express
 * "we could not find out", so `unavailable` is a first-class state and is
 * asserted to be retryable rather than actionable.
 */

import {
  amountToStroops,
  buildAccountAssetSnapshot,
  classifyTrustlineAuthorization,
  decodeIssuerFlags,
  findCreditBalance,
  trustlineHeadroomStroops,
  type AccountAssetSnapshot,
  type AssetBalance,
} from "@/shared-d/utils/stellar-asset-reader";
import {
  MINIMUM_BASE_FEE_STROOPS,
  classifyAssetReadiness,
  describeAssetReadiness,
  hasTrustlineRemediation,
  isAssetReady,
  isRetryableReadiness,
  maskAccountId,
  preflightAssetReadiness,
  type AssetDescriptor,
} from "@/shared-d/utils/asset-readiness";

const HOLDER = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";
const ISSUER = "GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL";

const USDC: AssetDescriptor = { kind: "credit", code: "USDC", issuer: ISSUER };
const XLM: AssetDescriptor = { kind: "native", code: "XLM" };

const BASE_RESERVE = 5_000_000n; // 0.5 XLM
const OBSERVED_AT = 1_700_000_000_000;

/**
 * Raw Horizon-shaped balances, as `buildAccountAssetSnapshot` expects: it runs
 * `normalizeBalance` over `account.balances` itself, so handing it
 * already-normalised objects would silently read every field as absent.
 */
function rawNative(overrides: Record<string, unknown> = {}) {
  return {
    asset_type: "native",
    balance: "100.0000000",
    limit: null,
    buying_liabilities: "0.0000000",
    selling_liabilities: "0.0000000",
    last_modified_ledger: 100,
    last_modified_time: "2023-11-14T22:13:20Z",
    sponsor: null,
    ...overrides,
  };
}

function rawCredit(overrides: Record<string, unknown> = {}) {
  return {
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: ISSUER,
    balance: "0.0000000",
    limit: "922337203685.4775807",
    buying_liabilities: "0.0000000",
    selling_liabilities: "0.0000000",
    is_authorized: true,
    is_authorized_to_maintain_liabilities: true,
    is_clawback_enabled: false,
    last_modified_ledger: 100,
    last_modified_time: "2023-11-14T22:13:20Z",
    sponsor: null,
    ...overrides,
  };
}

/** Already-normalised balance, for the pure `AssetBalance` helpers only. */
function creditBalance(overrides: Partial<AssetBalance> = {}): AssetBalance {
  return {
    assetType: "credit_alphanum4",
    assetCode: "USDC",
    assetIssuer: ISSUER,
    balance: "0.0000000",
    limit: "922337203685.4775807",
    buyingLiabilities: "0.0000000",
    sellingLiabilities: "0.0000000",
    authorization: "full",
    clawbackEnabled: false,
    lastModifiedLedger: 100,
    lastModifiedTime: "2023-11-14T22:13:20Z",
    sponsor: null,
    isCredit: true,
    ...overrides,
  };
}

interface SnapshotOptions {
  native?: Record<string, unknown> | null;
  balances?: Record<string, unknown>[];
  subentryCount?: number;
  numSponsoring?: number;
  numSponsored?: number;
  issuerFlags?: Parameters<typeof decodeIssuerFlags>[0] | null;
  issuerExists?: boolean | null;
  baseReserveStroops?: bigint;
  baseReserveFromLedger?: boolean;
  baseFeeStroops?: bigint | null;
}

function snapshot(options: SnapshotOptions = {}): AccountAssetSnapshot {
  const {
    native = rawNative(),
    balances = [],
    subentryCount = 0,
    numSponsoring = 0,
    numSponsored = 0,
    issuerFlags = null,
    issuerExists = true,
    baseReserveStroops = BASE_RESERVE,
    baseReserveFromLedger = true,
    baseFeeStroops = 100n,
  } = options;

  return buildAccountAssetSnapshot({
    publicKey: HOLDER,
    account: {
      account_id: HOLDER,
      sequence: "100",
      subentry_count: subentryCount,
      num_sponsoring: numSponsoring,
      num_sponsored: numSponsored,
      last_modified_ledger: 100,
      last_modified_time: "2023-11-14T22:13:20Z",
      home_domain: "example.test",
      thresholds: {},
      flags: {},
      balances: native ? [native, ...balances] : balances,
    } as never,
    baseReserveStroops,
    baseReserveFromLedger,
    baseFeeStroops,
    issuerFlags: issuerFlags ? decodeIssuerFlags(issuerFlags) : null,
    issuerHomeDomain: "issuer.example",
    issuerExists,
    observedAtMs: OBSERVED_AT,
  });
}

const oneToken = 1n; // 0.0000001

describe("buildAccountAssetSnapshot — reserve arithmetic", () => {
  it("charges two base entries for a brand new account", () => {
    const s = snapshot();

    // (2 + 0 subentries) * 0.5 XLM
    expect(s.minimumBalanceStroops).toBe(10_000_000n);
    expect(s.subentryCostStroops).toBe(BASE_RESERVE);
  });

  it("adds one base reserve per subentry", () => {
    const s = snapshot({ subentryCount: 3 });

    expect(s.minimumBalanceStroops).toBe(5n * BASE_RESERVE);
  });

  it("offsets sponsored entries, which are prepaid by the sponsor", () => {
    const s = snapshot({ subentryCount: 1, numSponsoring: 2, numSponsored: 2 });

    // 2 base + 1 subentry + 2 sponsoring - 2 sponsored
    expect(s.minimumBalanceStroops).toBe(3n * BASE_RESERVE);
  });

  it("excludes native selling liabilities from what can fund a new subentry", () => {
    const s = snapshot({
      native: rawNative({
        balance: "10.0000000",
        selling_liabilities: "2.0000000",
      }),
    });

    // Minimum balance for a bare account is 2 * 0.5 XLM = 1 XLM, so
    // 10 XLM - 2 XLM already promised - 1 XLM minimum = 7 XLM.
    expect(s.minimumBalanceStroops).toBe(10_000_000n);
    expect(s.availableAboveReserveStroops).toBe(70_000_000n);
  });

  it("tracks a base reserve change, which is why the ledger is read rather than assumed", () => {
    const atFive = snapshot({ baseReserveStroops: 5_000_000n });
    const atOne = snapshot({ baseReserveStroops: 1_000_000n });

    expect(atFive.subentryCostStroops).toBe(5_000_000n);
    expect(atOne.subentryCostStroops).toBe(1_000_000n);
    expect(atOne.minimumBalanceStroops).toBe(2_000_000n);
  });
});

describe("classifyAssetReadiness — native", () => {
  it("reports native and lets the caller proceed", () => {
    const readiness = classifyAssetReadiness(XLM, snapshot(), 1_000_000n);

    expect(readiness.state).toBe("native");
    expect(isAssetReady(readiness)).toBe(true);
    expect(readiness.remediation).toBeNull();
    expect(hasTrustlineRemediation(readiness)).toBe(false);
  });

  it("does not require a trustline even when the account is below its reserve", () => {
    const broke = snapshot({
      native: rawNative({ balance: "0.1000000" }),
    });
    const readiness = classifyAssetReadiness(XLM, broke, 1_000_000n);

    expect(readiness.state).toBe("native");
    expect(isAssetReady(readiness)).toBe(true);
  });
});

describe("classifyAssetReadiness — trustline states", () => {
  it("reports ready when the limit covers the requirement", () => {
    const s = snapshot({ balances: [rawCredit({ limit: "1000.0000000" })] });
    const readiness = classifyAssetReadiness(USDC, s, amountToStroops("100.0000000"));

    expect(readiness.state).toBe("ready");
    expect(isAssetReady(readiness)).toBe(true);
    if (readiness.state !== "ready") throw new Error("unreachable");
    expect(readiness.authorization).toBe("full");
    expect(readiness.headroomStroops).toBe(amountToStroops("1000.0000000"));
    expect(readiness.remediation).toBeNull();
  });

  it("reports missing_trustline and a remediation that names the asset and issuer", () => {
    const readiness = classifyAssetReadiness(USDC, snapshot(), amountToStroops("100.0000000"));

    expect(readiness.state).toBe("missing_trustline");
    expect(isAssetReady(readiness)).toBe(false);
    expect(hasTrustlineRemediation(readiness)).toBe(true);
    if (!readiness.remediation) throw new Error("unreachable");

    expect(readiness.remediation.issuer).toBe(ISSUER);
    expect(readiness.remediation.asset.code).toBe("USDC");
    // Exact requirement, no invented headroom multiplier.
    expect(readiness.remediation.limit).toBe("100.0000000");
    expect(readiness.remediation.limitStroops).toBe(amountToStroops("100.0000000"));
  });

  it("reports missing_trustline before checking the limit, since there is no limit yet", () => {
    const readiness = classifyAssetReadiness(USDC, snapshot(), 0n);

    expect(readiness.state).toBe("missing_trustline");
  });

  it("reports insufficient_limit with the exact shortfall", () => {
    const s = snapshot({ balances: [rawCredit({ limit: "50.0000000" })] });
    const readiness = classifyAssetReadiness(USDC, s, amountToStroops("100.0000000"));

    expect(readiness.state).toBe("insufficient_limit");
    if (readiness.state !== "insufficient_limit") throw new Error("unreachable");
    expect(readiness.shortfallStroops).toBe(amountToStroops("50.0000000"));
    // The remediation raises the limit to required + existing balance, not by a
    // multiple, and never below the current limit.
    expect(readiness.remediation.limit).toBe("100.0000000");
  });

  it("never lowers an existing limit below what it already is", () => {
    const s = snapshot({ balances: [rawCredit({ limit: "500.0000000" })] });
    const readiness = classifyAssetReadiness(USDC, s, amountToStroops("100.0000000"));

    expect(readiness.state).toBe("ready");
  });

  it("subtracts buying liabilities, which a raw limit comparison would miss", () => {
    // Limit 100, but 60 is already committed to an open buy offer, so only 40
    // is free. Without the liability this reports `ready` and the payment
    // fails on chain with op_buy_line_full *after* the user has signed.
    const s = snapshot({
      balances: [rawCredit({ limit: "100.0000000", buying_liabilities: "60.0000000" })],
    });
    const readiness = classifyAssetReadiness(USDC, s, amountToStroops("50.0000000"));

    expect(readiness.state).toBe("insufficient_limit");
    if (readiness.state !== "insufficient_limit") throw new Error("unreachable");
    expect(readiness.headroomStroops).toBe(amountToStroops("40.0000000"));
    expect(readiness.shortfallStroops).toBe(amountToStroops("10.0000000"));
  });

  it("reports a maintain-only authorization and offers no remediation", () => {
    const s = snapshot({
      balances: [rawCredit({ is_authorized: false, is_authorized_to_maintain_liabilities: true })],
    });
    const readiness = classifyAssetReadiness(USDC, s, amountToStroops("1.0000000"));

    expect(readiness.state).toBe("unauthorized");
    if (readiness.state !== "unauthorized") throw new Error("unreachable");
    expect(readiness.authorization).toBe("maintain_only");
    // Offering a `changeTrust` here would fail on chain and waste a signature.
    expect(readiness.remediation).toBeNull();
    expect(hasTrustlineRemediation(readiness)).toBe(false);
  });

  it("reports a fully deauthorized trustline", () => {
    const s = snapshot({
      balances: [rawCredit({ is_authorized: false, is_authorized_to_maintain_liabilities: false })],
    });
    const readiness = classifyAssetReadiness(USDC, s, amountToStroops("1.0000000"));

    expect(readiness.state).toBe("unauthorized");
    if (readiness.state !== "unauthorized") throw new Error("unreachable");
    expect(readiness.authorization).toBe("deauthorized");
  });
});

describe("classifyAssetReadiness — reserve", () => {
  it("reports insufficient_reserve with the exact XLM shortfall", () => {
    // Minimum balance for a bare account is 2 * 0.5 XLM = 1 XLM, so 0.6 XLM is
    // already 0.4 XLM under it, and a subentry costs another 0.5 XLM: a total
    // shortfall of 0.9 XLM.
    const poor = snapshot({ native: rawNative({ balance: "0.6000000" }) });
    const readiness = classifyAssetReadiness(USDC, poor, amountToStroops("1.0000000"));

    expect(readiness.state).toBe("insufficient_reserve");
    if (readiness.state !== "insufficient_reserve") throw new Error("unreachable");
    expect(readiness.shortfallStroops).toBe(9_000_000n);
  });

  it("does not charge reserve for raising the limit of an existing trustline", () => {
    // One subentry already exists and is already paid for, so widening the
    // limit must not be blocked on having another subentry's worth of XLM.
    const s = snapshot({
      subentryCount: 1,
      balances: [rawCredit({ limit: "1.0000000" })],
    });
    const readiness = classifyAssetReadiness(USDC, s, amountToStroops("100.0000000"));

    expect(readiness.state).toBe("insufficient_limit");
    if (readiness.state !== "insufficient_limit") throw new Error("unreachable");
    expect(readiness.remediation.reserveImpactStroops).toBe(0n);
  });

  it("charges reserve for creating a new trustline and says so in the remediation", () => {
    const readiness = classifyAssetReadiness(USDC, snapshot(), amountToStroops("1.0000000"));

    expect(readiness.state).toBe("missing_trustline");
    if (!readiness.remediation) throw new Error("unreachable");
    expect(readiness.remediation.reserveImpactStroops).toBe(BASE_RESERVE);
  });
});

describe("classifyAssetReadiness — issuer and asset metadata", () => {
  it("reports issuer_not_found and offers no remediation", () => {
    const readiness = classifyAssetReadiness(
      USDC,
      snapshot({ issuerExists: false }),
      amountToStroops("1.0000000"),
    );

    expect(readiness.state).toBe("issuer_not_found");
    expect(readiness.remediation).toBeNull();
  });

  it("does not claim the issuer is missing when the read simply failed", () => {
    // `issuerExists: null` means "unknown"; the trustline state speaks for
    // itself rather than the user being told the issuer does not exist.
    const readiness = classifyAssetReadiness(
      USDC,
      snapshot({ issuerExists: null }),
      amountToStroops("1.0000000"),
    );

    expect(readiness.state).toBe("missing_trustline");
  });

  it("surfaces issuer flags the confirmation UI must disclose", () => {
    const readiness = classifyAssetReadiness(
      USDC,
      snapshot({
        issuerFlags: {
          auth_required: true,
          auth_revocable: true,
          auth_clawback_enabled: true,
        },
      }),
      amountToStroops("1.0000000"),
    );

    if (!readiness.remediation) throw new Error("unreachable");
    expect(readiness.remediation.requiresIssuerAuthorization).toBe(true);
    expect(readiness.remediation.issuerCanRevoke).toBe(true);
    expect(readiness.remediation.issuerClawbackEnabled).toBe(true);
    expect(readiness.remediation.issuerHomeDomain).toBe("issuer.example");
  });

  it("rejects a malformed asset code", () => {
    for (const code of ["US", "US-D", "TOOLONGASSETCODE", "1USDC"]) {
      const readiness = classifyAssetReadiness(
        { kind: "credit", code, issuer: ISSUER },
        snapshot(),
        oneToken,
      );

      // A 2-character code is legal, so only the genuinely malformed ones
      // are asserted here; the point is that nothing reaches a signature.
      if (code === "US") {
        expect(readiness.state).not.toBe("invalid_asset");
        continue;
      }
      expect(readiness.state).toBe("invalid_asset");
      expect(readiness.remediation).toBeNull();
    }
  });

  it("accepts a 1- and 2-character code, which the protocol allows", () => {
    expect(
      classifyAssetReadiness(
        { kind: "credit", code: "US", issuer: ISSUER },
        snapshot(),
        oneToken,
      ).state,
    ).toBe("missing_trustline");
  });

  it("rejects a missing issuer rather than building a trustline to nothing", () => {
    const readiness = classifyAssetReadiness(
      { kind: "credit", code: "USDC", issuer: "" },
      snapshot(),
      oneToken,
    );

    expect(readiness.state).toBe("invalid_asset");
  });

  it("rejects a self-issued trustline, which could never become authorized", () => {
    const readiness = classifyAssetReadiness(
      { kind: "credit", code: "USDC", issuer: HOLDER },
      snapshot(),
      oneToken,
    );

    expect(readiness.state).toBe("invalid_asset");
  });
});

describe("classifyAssetReadiness — exact (code, issuer) matching", () => {
  it("ignores a trustline for the same code under a different issuer", () => {
    const otherIssuer = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
    const s = snapshot({
      balances: [
        rawCredit({ asset_issuer: otherIssuer, limit: "1000000.0000000" }),
      ],
    });
    const readiness = classifyAssetReadiness(USDC, s, amountToStroops("10.0000000"));

    // A huge limit under the wrong issuer must not make USDC look ready.
    expect(readiness.state).toBe("missing_trustline");
  });

  it("ignores a trustline for a different code", () => {
    const s = snapshot({
      balances: [rawCredit({ asset_code: "EURC", limit: "1000000.0000000" })],
    });
    const readiness = classifyAssetReadiness(USDC, s, amountToStroops("10.0000000"));

    expect(readiness.state).toBe("missing_trustline");
  });

  it("ignores liquidity pool shares, which have a limit-less balance shape", () => {
    const s = snapshot({
      balances: [
        rawCredit({
          asset_type: "liquidity_pool_shares",
          asset_code: null,
          asset_issuer: null,
          limit: null,
        }),
      ],
    });
    const readiness = classifyAssetReadiness(USDC, s, amountToStroops("10.0000000"));

    expect(readiness.state).toBe("missing_trustline");
  });
});

describe("authorization classification", () => {
  it("prefers full authorization when both flags are set", () => {
    expect(
      classifyTrustlineAuthorization({
        is_authorized: true,
        is_authorized_to_maintain_liabilities: true,
      }),
    ).toBe("full");
  });

  it("falls back to maintain-only rather than calling it deauthorized", () => {
    expect(
      classifyTrustlineAuthorization({
        is_authorized: false,
        is_authorized_to_maintain_liabilities: true,
      }),
    ).toBe("maintain_only");
  });

  it("treats both flags absent as deauthorized, which is the safe direction", () => {
    expect(
      classifyTrustlineAuthorization({
        is_authorized: false,
        is_authorized_to_maintain_liabilities: false,
      }),
    ).toBe("deauthorized");
  });

  it("treats entirely absent flags as deauthorized", () => {
    expect(classifyTrustlineAuthorization({})).toBe("deauthorized");
  });
});

describe("describeAssetReadiness", () => {
  it("produces a non-empty, actionable message for every remediable state", () => {
    const states = [
      classifyAssetReadiness(XLM, snapshot(), oneToken),
      classifyAssetReadiness(USDC, snapshot(), amountToStroops("1.0000000")),
      classifyAssetReadiness(
        USDC,
        snapshot({ balances: [rawCredit({ limit: "1.0000000" })] }),
        amountToStroops("100.0000000"),
      ),
      classifyAssetReadiness(
        USDC,
        snapshot({ native: rawNative({ balance: "0.6000000" }) }),
        amountToStroops("1.0000000"),
      ),
      classifyAssetReadiness(
        USDC,
        snapshot({ balances: [rawCredit({ is_authorized: false, is_authorized_to_maintain_liabilities: false })] }),
        amountToStroops("1.0000000"),
      ),
      classifyAssetReadiness(USDC, snapshot({ issuerExists: false }), oneToken),
    ];

    for (const readiness of states) {
      const message = describeAssetReadiness(readiness);
      expect(message.length).toBeGreaterThan(0);
      expect(message).toMatch(/\S/);
    }
  });

  it("states the issuer and limit in the missing-trustline copy", () => {
    const message = describeAssetReadiness(
      classifyAssetReadiness(USDC, snapshot(), amountToStroops("25.0000000")),
    );

    expect(message).toContain("USDC");
    expect(message).toContain("25");
  });
});

describe("maskAccountId", () => {
  it("never returns the full account id, so it is safe for logs and telemetry", () => {
    const masked = maskAccountId(HOLDER);

    expect(masked).not.toBe(HOLDER);
    expect(masked.length).toBeLessThan(HOLDER.length);
    expect(HOLDER.startsWith(masked.slice(0, 4))).toBe(true);
  });

  it("does not throw on a malformed id", () => {
    expect(() => maskAccountId("")).not.toThrow();
    expect(() => maskAccountId("short")).not.toThrow();
  });
});

describe("preflightAssetReadiness — network failures", () => {
  const horizonUrl = "https://horizon.test";

  function accountResponse(balances: unknown[], subentryCount = 0) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        account_id: HOLDER,
        sequence: "100",
        subentry_count: subentryCount,
        num_sponsoring: 0,
        num_sponsored: 0,
        last_modified_ledger: 100,
        home_domain: "example.test",
        thresholds: {},
        flags: {},
        balances,
      }),
    } as Response;
  }

  function jsonResponse(body: unknown) {
    return { ok: true, status: 200, json: async () => body } as Response;
  }

  it("reports `unavailable` and offers a retry when Horizon fails outright", async () => {
    const readiness = await preflightAssetReadiness(
      { asset: USDC, amountStroops: amountToStroops("1.0000000") },
      {
        horizonUrl,
        publicKey: HOLDER,
        fetchFn: jest.fn().mockResolvedValue({
          ok: false,
          status: 503,
          json: async () => ({}),
        } as Response),
      },
    );

    expect(readiness.state).toBe("unavailable");
    expect(isAssetReady(readiness)).toBe(false);
    expect(isRetryableReadiness(readiness)).toBe(true);
    // An unknown state must not offer a repair action.
    expect(readiness.remediation).toBeNull();
  });

  it("reports `unavailable` rather than `ready` when the payload is malformed", async () => {
    const fetchFn = jest.fn().mockImplementation((url: string) => {
      if (String(url).includes("/ledgers")) {
        return Promise.resolve(jsonResponse({ records: [{ sequence: 1, base_reserve_in_stroops: 5_000_000 }] }));
      }
      // A balance with an unparseable amount must not be coerced to zero.
      return Promise.resolve(
        accountResponse([{ asset_type: "native", balance: "not-a-number" }]),
      );
    });

    const readiness = await preflightAssetReadiness(
      { asset: USDC, amountStroops: amountToStroops("1.0000000") },
      { horizonUrl, publicKey: HOLDER, fetchFn: fetchFn as never },
    );

    expect(readiness.state).toBe("unavailable");
    expect(isRetryableReadiness(readiness)).toBe(true);
  });

  it("reports `account_not_found` when the connected account does not exist", async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as Response);

    const readiness = await preflightAssetReadiness(
      { asset: USDC, amountStroops: amountToStroops("1.0000000") },
      { horizonUrl, publicKey: HOLDER, fetchFn: fetchFn as never },
    );

    expect(readiness.state).toBe("account_not_found");
    // Not retryable: the wallet needs funding before this can change.
    expect(isRetryableReadiness(readiness)).toBe(false);
  });

  it("falls back to the protocol reserve when only the ledger read fails", async () => {
    const fetchFn = jest.fn().mockImplementation((url: string) => {
      if (String(url).includes("/ledgers")) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response);
      }
      return Promise.resolve(accountResponse([{ asset_type: "native", balance: "10.0000000" }]));
    });

    const readiness = await preflightAssetReadiness(
      { asset: USDC, amountStroops: amountToStroops("1.0000000") },
      {
        horizonUrl,
        publicKey: HOLDER,
        fetchFn: fetchFn as never,
        fallbackBaseReserveStroops: BASE_RESERVE,
      },
    );

    expect(readiness.state).toBe("missing_trustline");
    if (!readiness.remediation) throw new Error("unreachable");
    expect(readiness.remediation.reserveImpactStroops).toBe(BASE_RESERVE);
    // Approximate because the ledger read failed, and the UI says so.
    expect(readiness.snapshot?.baseReserveApproximate).toBe(true);
  });

  it("uses the ledger's current base reserve when it can be read", async () => {
    const fetchFn = jest.fn().mockImplementation((url: string) => {
      if (String(url).includes("/ledgers")) {
        // A raised reserve must be honoured, not assumed to be 0.5 XLM.
        return Promise.resolve(
          jsonResponse({ records: [{ sequence: 1, base_reserve_in_stroops: 10_000_000 }] }),
        );
      }
      return Promise.resolve(accountResponse([{ asset_type: "native", balance: "50.0000000" }]));
    });

    const readiness = await preflightAssetReadiness(
      { asset: USDC, amountStroops: amountToStroops("1.0000000") },
      { horizonUrl, publicKey: HOLDER, fetchFn: fetchFn as never },
    );

    if (!readiness.remediation) throw new Error("unreachable");
    expect(readiness.remediation.reserveImpactStroops).toBe(10_000_000n);
    expect(readiness.snapshot?.baseReserveApproximate).toBe(false);
  });

  it("estimates the fee from the ledger's base fee, falling back to the minimum", async () => {
    const withLedger = await preflightAssetReadiness(
      { asset: USDC, amountStroops: amountToStroops("1.0000000") },
      {
        horizonUrl,
        publicKey: HOLDER,
        fetchFn: jest.fn().mockImplementation((url: string) =>
          Promise.resolve(
            String(url).includes("/ledgers")
              ? jsonResponse({ records: [{ sequence: 1, base_reserve_in_stroops: 5_000_000, base_fee_in_stroops: 250 }] })
              : accountResponse([{ asset_type: "native", balance: "10.0000000" }]),
          ),
        ) as never,
      },
    );
    expect(withLedger.remediation?.estimatedFeeStroops).toBe(250n);

    const withoutLedger = await preflightAssetReadiness(
      { asset: USDC, amountStroops: amountToStroops("1.0000000") },
      {
        horizonUrl,
        publicKey: HOLDER,
        fetchFn: jest.fn().mockImplementation((url: string) =>
          String(url).includes("/ledgers")
            ? Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response)
            : Promise.resolve(accountResponse([{ asset_type: "native", balance: "10.0000000" }])),
        ) as never,
      },
    );
    expect(withoutLedger.remediation?.estimatedFeeStroops).toBe(MINIMUM_BASE_FEE_STROOPS);
  });

  it("rejects an invalid asset before making any network call", async () => {
    const fetchFn = jest.fn();

    const readiness = await preflightAssetReadiness(
      { asset: { kind: "credit", code: "US-D", issuer: ISSUER }, amountStroops: 1n },
      { horizonUrl, publicKey: HOLDER, fetchFn: fetchFn as never },
    );

    expect(readiness.state).toBe("invalid_asset");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("findCreditBalance / trustlineHeadroomStroops", () => {
  it("matches on both code and issuer, not code alone", () => {
    const other = creditBalance({ assetIssuer: "GOTHER", limit: "5.0000000" });
    const match = creditBalance({ limit: "7.0000000" });

    expect(findCreditBalance([other, match], "USDC", ISSUER)?.limit).toBe("7.0000000");
    expect(findCreditBalance([other], "USDC", ISSUER)).toBeNull();
  });

  it("treats a null limit as zero headroom, not as unlimited", () => {
    // A `null` limit is what Horizon reports for pool shares and native. Reading
    // it as unlimited would report an unbacked asset as fully available.
    expect(trustlineHeadroomStroops(creditBalance({ limit: null }))).toBe(0n);
  });

  it("computes headroom as limit minus balance minus buying liabilities", () => {
    const headroom = trustlineHeadroomStroops(
      creditBalance({
        limit: "100.0000000",
        balance: "10.0000000",
        buyingLiabilities: "5.0000000",
      }),
    );

    expect(headroom).toBe(amountToStroops("85.0000000"));
  });
});
