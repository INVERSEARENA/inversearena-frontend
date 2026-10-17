import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ClaimInboxPanel } from "../components/ClaimInboxPanel";
import type { ClaimInboxItem } from "../types";

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
    action: { type: "claim", label: "CLAIM WINNINGS", endpoint: null },
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

describe("ClaimInboxPanel", () => {
  it("says so plainly when there is nothing waiting", async () => {
    mockFetch.mockResolvedValueOnce(ok(page([])));

    render(<ClaimInboxPanel />);

    expect(await screen.findByText(/Nothing waiting on you/)).toBeInTheDocument();
  });

  it("renders an actionable position with its amount and action", async () => {
    mockFetch.mockResolvedValueOnce(ok(page([item()])));

    render(<ClaimInboxPanel />);

    expect(await screen.findByText("Arena A")).toBeInTheDocument();
    expect(screen.getByText("ACTIONABLE")).toBeInTheDocument();
    // 25_000_000 stroops rendered exactly, not through a float.
    expect(screen.getByText(/2\.5000000 XLM/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "CLAIM WINNINGS" })).toBeInTheDocument();
  });

  it("renders an unavailable position as an explicit unknown with a retry", async () => {
    // The failure this whole endpoint exists to prevent: a real payout shown as
    // "nothing to do" because a chain read failed.
    mockFetch.mockResolvedValueOnce(
      ok(
        page(
          [
            item({
              state: "unavailable",
              reason: "rpc_unavailable",
              message: "Could not read the arena on chain.",
              action: { type: "retry", label: "TRY AGAIN", endpoint: null },
            }),
          ],
          { verificationComplete: false },
        ),
      ),
    );

    render(<ClaimInboxPanel />);

    expect(await screen.findByText("UNAVAILABLE")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "TRY AGAIN" })).toBeInTheDocument();
    // And the incomplete scan is disclosed rather than implied.
    expect(screen.getByText(/could not be verified against the chain/)).toBeInTheDocument();
    // The amount is still real money, not zeroed.
    expect(screen.getByText(/2\.5000000 XLM/)).toBeInTheDocument();
  });

  it("renders pending, completed and blocked distinctly", async () => {
    mockFetch.mockResolvedValueOnce(
      ok(
        page([
          item({ id: "p", arenaId: ARENA_A, arenaName: "Pending one", state: "pending", reason: "payout_submitted", action: null }),
          item({ id: "c", arenaId: ARENA_B, arenaName: "Done one", state: "completed", reason: "payout_confirmed", action: { type: "view_history", label: "VIEW HISTORY", endpoint: null } }),
          item({ id: "b", arenaId: "C0000000000000000000000000000000000000000000000000000003", arenaName: "Blocked one", state: "blocked", reason: "arena_not_finished", action: null }),
        ]),
      ),
    );

    render(<ClaimInboxPanel />);

    expect(await screen.findByText("PENDING")).toBeInTheDocument();
    expect(screen.getByText("COMPLETED")).toBeInTheDocument();
    expect(screen.getByText("BLOCKED")).toBeInTheDocument();
  });

  it("marks a stale record as stale", async () => {
    mockFetch.mockResolvedValueOnce(
      ok(
        page([
          item({
            freshness: {
              recordUpdatedAt: "2026-09-27T09:00:00.000Z",
              recordAgeSeconds: 7200,
              stale: true,
              ledgerSequence: null,
              verifiedAt: "2026-09-27T11:00:00.000Z",
            },
          }),
        ]),
      ),
    );

    render(<ClaimInboxPanel />);

    expect(await screen.findByText("stale")).toBeInTheDocument();
    expect(screen.getByText("records 2h ago")).toBeInTheDocument();
  });

  it("re-reads after a retry instead of patching the row locally", async () => {
    mockFetch.mockResolvedValueOnce(
      ok(page([item({ state: "unavailable", reason: "rpc_unavailable", action: { type: "retry", label: "TRY AGAIN", endpoint: null } })])),
    );
    render(<ClaimInboxPanel />);
    await screen.findByRole("button", { name: "TRY AGAIN" });

    mockFetch.mockResolvedValueOnce(ok(page([item({ state: "actionable" })])));
    fireEvent.click(screen.getByRole("button", { name: "TRY AGAIN" }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    // The verdict comes from the server, never from the click.
    expect(await screen.findByText("ACTIONABLE")).toBeInTheDocument();
  });

  it("discloses a pending reconciliation without hiding the server's verdict", async () => {
    mockFetch.mockResolvedValueOnce(
      ok(page([item({ state: "unavailable", reason: "rpc_unavailable", action: { type: "retry", label: "TRY AGAIN", endpoint: null } })])),
    );
    render(<ClaimInboxPanel />);
    await screen.findByRole("button", { name: "TRY AGAIN" });

    // Still unavailable, still saying so.
    mockFetch.mockResolvedValueOnce(ok(page([item({ state: "unavailable", reason: "rpc_unavailable" })])));
    fireEvent.click(screen.getByRole("button", { name: "TRY AGAIN" }));

    // A re-read that has not caught up must not read as settled.
    expect(await screen.findByText("UNAVAILABLE")).toBeInTheDocument();
    expect(screen.getByText("awaiting chain confirmation")).toBeInTheDocument();
  });

  it("shows a load-more control only when the server says there is more", async () => {
    mockFetch.mockResolvedValueOnce(ok(page([item()], { hasMore: true, cursor: "cur-1" })));

    render(<ClaimInboxPanel />);

    expect(await screen.findByRole("button", { name: "LOAD MORE" })).toBeInTheDocument();
  });

  it("reports a failed load", async () => {
    mockFetch.mockResolvedValueOnce(
      Promise.resolve({ ok: false, status: 401, json: async () => ({}) } as Response),
    );

    render(<ClaimInboxPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent("401");
  });

  it("never renders a wallet address into the page", async () => {
    mockFetch.mockResolvedValueOnce(ok(page([item()])));

    const { container } = render(<ClaimInboxPanel />);
    await screen.findByText("Arena A");

    // The panel echoes the wallet in the response but must not put it on screen.
    expect(container.textContent).not.toContain(WALLET);
  });
});
