/**
 * Regression tests for issue #1298
 *
 * The withdrawal-success page must NOT render a convincing "payout confirmed"
 * screen when opened directly via a crafted URL (i.e., no sessionStorage
 * token).  Only navigations that originate from the real withdrawal flow —
 * which call markWithdrawalComplete() before pushing the route — should be
 * allowed through.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import WithdrawalSuccessPage from "../page";
import { markWithdrawalComplete, WITHDRAWAL_TOKEN_KEY } from "@/lib/withdrawalSession";

// ---------------------------------------------------------------------------
// next/navigation stubs
//
// jest.mock() is hoisted before any variable initialisations, so the factory
// cannot close over module-scope let/const.  The standard workaround is to
// expose the spy via a separate require inside beforeEach, or to capture it on
// a mutable module-scope object that IS available at hoist time (because
// object mutations happen at runtime).  We use the latter: `_nav` holds the
// spy references and is mutated in the factory.
// ---------------------------------------------------------------------------
const _nav: { replace: jest.Mock; searchParamsStub: Record<string, string> } = {
  replace: jest.fn(),
  searchParamsStub: {},
};

jest.mock("next/navigation", () => {
  // _nav is referenced here at factory-evaluation time (after hoisting).
  // The object itself exists because object literals are evaluated at
  // declaration time; only the variable binding is hoisted, not the value.
  const router = { replace: (...args: Parameters<typeof _nav.replace>) => _nav.replace(...args) };
  return {
    useRouter: () => router,
    useSearchParams: () => ({
      get: (key: string) => _nav.searchParamsStub[key] ?? null,
    }),
  };
});

// ---------------------------------------------------------------------------
// framer-motion stub (avoid animation overhead in tests)
// ---------------------------------------------------------------------------
jest.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...rest }: React.HTMLAttributes<HTMLDivElement>) =>
      React.createElement("div", rest, children),
  },
}));

// ---------------------------------------------------------------------------
// withdrawal component stubs
// ---------------------------------------------------------------------------
jest.mock("@/components/arena-v2/withdrawal/SuccessHeader", () => ({
  SuccessHeader: () => <div>SUCCESS_HEADER</div>,
}));
jest.mock("@/components/arena-v2/withdrawal/UnlockedPadlock", () => ({
  UnlockedPadlock: () => <div>UNLOCKED_PADLOCK</div>,
}));
jest.mock("@/components/arena-v2/withdrawal/WithdrawalDetails", () => ({
  WithdrawalDetails: () => <div>WITHDRAWAL_DETAILS</div>,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const VALID_PARAMS: Record<string, string> = {
  amount: "100.00",
  currency: "USDC",
  destination: "GBXXX",
  fee: "0.00001",
  feeToken: "XLM",
  txHash: "abc123deadbeef",
};

beforeEach(() => {
  _nav.replace.mockClear();
  sessionStorage.clear();
  _nav.searchParamsStub = { ...VALID_PARAMS };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WithdrawalSuccessPage – session guard (#1298)", () => {
  it("redirects to / and renders nothing when no session token is present (crafted URL attack)", () => {
    // Attacker crafts a URL with all required params but NO session token.
    render(<WithdrawalSuccessPage />);

    // Page must redirect away immediately.
    expect(_nav.replace).toHaveBeenCalledWith("/");

    // The success screen content must NOT be visible.
    expect(screen.queryByText("SUCCESS_HEADER")).not.toBeInTheDocument();
    expect(screen.queryByText("WITHDRAWAL_DETAILS")).not.toBeInTheDocument();
    expect(screen.queryByText("UNLOCKED_PADLOCK")).not.toBeInTheDocument();
  });

  it("does not show the success screen even when all query params look valid but the session token is missing", () => {
    render(<WithdrawalSuccessPage />);

    expect(screen.queryByText("SUCCESS_HEADER")).not.toBeInTheDocument();
  });

  it("renders the success screen when a valid session token is present", async () => {
    markWithdrawalComplete(); // simulate the real withdrawal flow writing the token

    render(<WithdrawalSuccessPage />);

    // Token should be consumed and success content displayed.
    expect(_nav.replace).not.toHaveBeenCalled();
    expect(await screen.findByText("SUCCESS_HEADER")).toBeInTheDocument();
    expect(screen.getByText("WITHDRAWAL_DETAILS")).toBeInTheDocument();
    expect(screen.getByText("UNLOCKED_PADLOCK")).toBeInTheDocument();
  });

  it("consumes the token so that a page refresh cannot re-display the success screen", async () => {
    markWithdrawalComplete();

    const { unmount } = render(<WithdrawalSuccessPage />);
    // Wait for the authorized render.
    await screen.findByText("SUCCESS_HEADER");
    unmount();

    // Simulate refresh – token must be gone from sessionStorage.
    expect(sessionStorage.getItem(WITHDRAWAL_TOKEN_KEY)).toBeNull();

    // Second render with no token should redirect.
    render(<WithdrawalSuccessPage />);
    expect(_nav.replace).toHaveBeenCalledWith("/");
    expect(screen.queryByText("SUCCESS_HEADER")).not.toBeInTheDocument();
  });

  it("shows 'No withdrawal data found' (not the success screen) when token is present but params are incomplete", async () => {
    markWithdrawalComplete();
    _nav.searchParamsStub = { amount: "", destination: "", txHash: "" }; // missing required fields

    render(<WithdrawalSuccessPage />);

    // Should not redirect, but should display the missing-data fallback.
    expect(_nav.replace).not.toHaveBeenCalled();
    expect(await screen.findByText(/no withdrawal data found/i)).toBeInTheDocument();
    expect(screen.queryByText("SUCCESS_HEADER")).not.toBeInTheDocument();
  });
});
