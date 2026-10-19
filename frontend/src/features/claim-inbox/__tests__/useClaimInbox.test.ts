import { act, renderHook, waitFor } from "@testing-library/react";

import { useClaimInbox } from "../useClaimInbox";
import { claimInboxPageSchema, type ClaimInboxItem } from "../types";

const mockFetch = jest.fn();

const WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const ARENA_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ARENA_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function item(over: Partial<ClaimInboxItem> = {}): ClaimInboxItem {
  return {
    id: ARENA_A,
    arenaId: ARENA_A,
    arenaName: "Arena A",
    kind: "winnings",
    state: "actionable",
    reason: "claim_ready",
    message: "Winnings are claimable now.",
    components: [
      {
        kind: "winnings",
        asset: { code: "XLM", issuer: null, decimals: 7 },
        amountStroops: "25000000",
        payoutId: null,
        status: null,
        txHash: null,
        confirmedAt: null,
        attempts: 0,
      },
    ],
    totalsByAsset: [{ code: "XLM", issuer: null, amountStroops: "25000000" }],
    freshness: {
      recordUpdatedAt: null,
      recordAgeSeconds: null,
      stale: false,
      ledgerSequence: null,
      verifiedAt: "2026-09-27T10:00:00.000Z",
    },
    action: { type: "claim", label: "CLAIM WINNINGS", endpoint: "/api/arenas/x/claim" },
    sortKey: "2026-09-27T10:00:00.000Z",
    ...over,
  };
}

function page(items: ClaimInboxItem[], over: Record<string, unknown> = {}) {
  return {
    version: 1,
    walletAddress: WALLET,
    items,
    summary: {
      actionable: items.filter((i) => i.state === "actionable").length,
      pending: 0,
      completed: 0,
      blocked: 0,
      unavailable: 0,
      total: items.length,
    },
    cursor: null,
    hasMore: false,
    verificationComplete: true,
    scanLatencyMs: 5,
    sources: { payouts: items.length, cancellationRecovery: 0 },
    ...over,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  global.fetch = mockFetch;
  Object.defineProperty(window, "localStorage", {
    value: { getItem: jest.fn(() => "token"), setItem: jest.fn(), removeItem: jest.fn() },
    writable: true,
  });
});

function ok(body: unknown): Promise<Response> {
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
}

describe("useClaimInbox", () => {
  it("parses a well-formed page and exposes the summary", async () => {
    mockFetch.mockResolvedValueOnce(ok(page([item()])));

    const { result } = renderHook(() => useClaimInbox());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.summary?.actionable).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it("sends the bearer token", async () => {
    mockFetch.mockResolvedValueOnce(ok(page([])));

    const { result } = renderHook(() => useClaimInbox());

    await waitFor(() => expect(result.current.loading).toBe(false));
    const [, init] = mockFetch.mock.calls[0];
    expect((init as RequestInit).headers).toEqual({ Authorization: "Bearer token" });
  });

  it("surfaces a contract mismatch instead of rendering undefined balances", async () => {
    // `amountStroops` as a number would be a precision bug waiting to happen.
    mockFetch.mockResolvedValueOnce(
      ok(page([item({ totalsByAsset: [{ code: "XLM", issuer: null, amountStroops: 25 } as never] })])),
    );

    const { result } = renderHook(() => useClaimInbox());

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toMatch(/Invalid claim inbox response/);
    expect(result.current.items).toHaveLength(0);
  });

  it("clears items when a refresh fails rather than showing stale rows as current", async () => {
    mockFetch.mockResolvedValueOnce(ok(page([item()])));
    const { result } = renderHook(() => useClaimInbox());
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    mockFetch.mockResolvedValueOnce(
      Promise.resolve({ ok: false, status: 503, json: async () => ({}) } as Response),
    );
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.items).toHaveLength(0);
    expect(result.current.error).toMatch(/503/);
  });

  it("appends the next page and follows the cursor", async () => {
    mockFetch.mockResolvedValueOnce(
      ok(page([item()], { cursor: "cur-1", hasMore: true, summary: { actionable: 1, pending: 0, completed: 0, blocked: 0, unavailable: 0, total: 1 } })),
    );
    const { result } = renderHook(() => useClaimInbox());
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    mockFetch.mockResolvedValueOnce(ok(page([item({ id: ARENA_B, arenaId: ARENA_B, arenaName: "Arena B" })])));
    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.items.map((i) => i.arenaId)).toEqual([ARENA_A, ARENA_B]);
    expect(mockFetch.mock.calls[1][0]).toContain("cursor=cur-1");
  });

  it("replaces an arena rather than duplicating it when a page overlaps", async () => {
    // Overlap is expected after a submission lands mid-pagination. Two rows for
    // one arena would invite a second signature for the same money.
    mockFetch.mockResolvedValueOnce(ok(page([item()], { cursor: "cur-1", hasMore: true })));
    const { result } = renderHook(() => useClaimInbox());
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    mockFetch.mockResolvedValueOnce(ok(page([item({ state: "pending", reason: "payout_submitted" })])));
    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]?.state).toBe("pending");
  });

  it("re-reads after a submission and never marks the item completed locally", async () => {
    mockFetch.mockResolvedValueOnce(ok(page([item()])));
    const { result } = renderHook(() => useClaimInbox());
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    // The server now says the payout is in flight.
    mockFetch.mockResolvedValueOnce(
      ok(page([item({ state: "pending", reason: "payout_submitted" })])),
    );
    await act(async () => {
      await result.current.markSubmitted(ARENA_A);
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Whatever the server said is what renders — a local "completed" would be
    // a settlement claim we cannot support.
    expect(result.current.items[0]?.state).toBe("pending");
    expect(result.current.reconciling.has(ARENA_A)).toBe(true);
  });

  it("reports an incomplete verification scan", async () => {
    mockFetch.mockResolvedValueOnce(ok(page([item({ state: "unavailable", reason: "rpc_unavailable" })], { verificationComplete: false })));

    const { result } = renderHook(() => useClaimInbox());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.verificationComplete).toBe(false);
    expect(result.current.items[0]?.state).toBe("unavailable");
  });
});

describe("claimInboxPageSchema", () => {
  it("accepts the documented page shape", () => {
    expect(claimInboxPageSchema.safeParse(page([item()])).success).toBe(true);
  });

  it("rejects an unknown state", () => {
    const parsed = claimInboxPageSchema.safeParse(
      page([item({ state: "settled" as never })]),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-decimal stroop amount", () => {
    expect(
      claimInboxPageSchema.safeParse(
        page([item({ totalsByAsset: [{ code: "XLM", issuer: null, amountStroops: "-5" }] })]),
      ).success,
    ).toBe(false);
  });
});
