/**
 * Tests for the staking position hook and exact amount formatting (#1510).
 */
import { renderHook, waitFor } from "@testing-library/react";

import { formatMinorUnits } from "../formatAmount";
import { deriveStakingState, useStakingPosition, type StakingPosition } from "../useStakingPosition";

const mockFetch = jest.fn();

beforeEach(() => {
  global.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockReset();
  const store: Record<string, string> = { access_token: "test-token" };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    },
  });
});

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function position(overrides: Partial<StakingPosition> = {}): StakingPosition {
  return {
    wallet: "GWALLET",
    assetDecimals: 7,
    network: "Test SDF Network ; September 2015",
    contractVersion: 1,
    freshness: "verified",
    ledger: 123,
    observedAt: "2026-01-01T00:00:00.000Z",
    shares: "10000000",
    principalEquivalent: "10000000",
    accruedRewards: "0",
    withdrawable: "10000000",
    minInitialStake: "10000000",
    totalStaked: "10000000",
    totalShares: "10000000",
    ...overrides,
  };
}

describe("deriveStakingState (#1510)", () => {
  it("maps null to loading", () => {
    expect(deriveStakingState(null)).toBe("loading");
  });

  it("maps unavailable freshness to unavailable (not empty)", () => {
    expect(deriveStakingState(position({ freshness: "unavailable", shares: null }))).toBe(
      "unavailable",
    );
  });

  it("maps a verified zero position to empty", () => {
    expect(
      deriveStakingState(
        position({ shares: "0", withdrawable: "0", accruedRewards: "0", principalEquivalent: "0" }),
      ),
    ).toBe("empty");
  });

  it("maps a non-zero position to active", () => {
    expect(deriveStakingState(position())).toBe("active");
  });
});

describe("formatMinorUnits (#1510)", () => {
  it("formats exact minor units with the given decimals", () => {
    expect(formatMinorUnits("10000000", 7)).toBe("1.0000000");
    expect(formatMinorUnits("1500000", 6)).toBe("1.500000");
    expect(formatMinorUnits("0", 7)).toBe("0.0000000");
    expect(formatMinorUnits(null, 7)).toBe("—");
  });

  it("trims trailing zeros only when asked", () => {
    expect(formatMinorUnits("1500000", 6, { trimTrailingZeros: true })).toBe("1.5");
  });

  it("does not lose precision on very large values", () => {
    expect(formatMinorUnits("1000000000000000001", 18)).toBe("1.000000000000000001");
  });
});

describe("useStakingPosition (#1510)", () => {
  it("fetches the position with an auth header and reports active", async () => {
    mockFetch.mockResolvedValue(ok({ version: 1, position: position() }));

    const { result } = renderHook(() => useStakingPosition());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/api/users/me/staking/positions");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(result.current.state).toBe("active");
    expect(result.current.position?.shares).toBe("10000000");
  });

  it("reports unavailable (not empty/zero) when the chain cannot be read", async () => {
    mockFetch.mockResolvedValue(
      ok({ version: 1, position: position({ freshness: "unavailable", shares: null, withdrawable: null }) }),
    );

    const { result } = renderHook(() => useStakingPosition());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.state).toBe("unavailable");
  });

  it("reports an error when the request fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as Response);

    const { result } = renderHook(() => useStakingPosition());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.state).toBe("error");
    expect(result.current.error).toContain("503");
  });
});
