/**
 * Regression test for #1294.
 *
 * The profile page's "CLAIM YIELD" and "EDIT PROFILE" buttons used to render
 * as fully styled, enabled CTAs with no onClick handler — clicking them did
 * nothing, which is especially confusing for "CLAIM YIELD" sitting directly
 * under the user's real, visible yield total. Until the flows are wired up
 * they must render as explicitly disabled controls with a "coming soon"
 * affordance.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import ProfilePage from "../page";

jest.mock("@/shared-d/hooks/useArenaSettings", () => ({
  useArenaSettings: () => ({
    settings: { notificationsEnabled: true },
    updateSetting: jest.fn(),
    resetDefaults: jest.fn(),
    isLoaded: true,
  }),
}));

jest.mock("@/features/wallet/useWallet", () => ({
  useWallet: () => ({ address: "GLADESIMZE000000000000000000000000000000000000000000000001" }),
}));

jest.mock("@/shared-d/features/profile/hooks/useProfile", () => ({
  useProfile: () => ({
    profile: {
      identity: { id: "AGENT-007", rank: 12 },
      stats: { gamesPlayed: 8, gamesWon: 3, totalYieldEarned: "42.50" },
    },
    myArenas: [],
    history: [],
    status: "success",
    error: undefined,
    refetch: jest.fn(),
  }),
}));

describe("ProfilePage dead CTA buttons (#1294)", () => {
  it("renders CLAIM YIELD as a disabled control, not a live CTA", () => {
    render(<ProfilePage />);

    const claim = screen.getByRole("button", { name: /claim yield/i });
    expect(claim).toBeDisabled();
    expect(claim).toHaveAttribute("title", expect.stringMatching(/isn't available yet/i));
  });

  it("renders EDIT PROFILE as a disabled control, not a live CTA", () => {
    render(<ProfilePage />);

    const edit = screen.getByRole("button", { name: /edit profile/i });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute("title", expect.stringMatching(/isn't available yet/i));
  });

  it("shows a visible 'coming soon' affordance next to the yield total", () => {
    render(<ProfilePage />);

    // The real yield figure is still shown…
    expect(screen.getByText(/42\.50 USDC/)).toBeInTheDocument();
    // …but the claim action is clearly flagged as not live.
    expect(screen.getByText(/claiming goes live/i)).toBeInTheDocument();
  });
});
