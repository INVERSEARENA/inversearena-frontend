import React from "react";
import { render, screen } from "@testing-library/react";
import { PublicProfileView, type PublicProfileData } from "../PublicProfileView";
import { generateMetadata } from "../page";

describe("Public Player Profile Page (#1742)", () => {
  const mockProfile: PublicProfileData = {
    address: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    alias: "neon_shadow",
    level: 7,
    joinedAt: "2026-03-01T00:00:00Z",
    stats: {
      gamesPlayed: 25,
      gamesWon: 12,
      totalYieldEarned: "1250.00",
      currentRank: 3,
      winRate: 48,
    },
    achievements: [
      {
        definitionId: "first_win",
        title: "First Blood",
        description: "Win your first arena",
        tier: "bronze",
        unlockedAt: "2026-03-02T00:00:00Z",
      },
    ],
    recentSettledArenas: [
      {
        arenaId: "arena-001",
        name: "Cyber Clash Alpha",
        settledAt: "2026-04-01T00:00:00Z",
        result: "won",
        payout: "250.00",
      },
    ],
    privacy: {
      hideHistory: false,
      hideFromSearch: false,
    },
  };

  it("renders public player alias, level, stats, and achievements", () => {
    render(<PublicProfileView profile={mockProfile} />);

    expect(screen.getByText("@neon_shadow")).toBeInTheDocument();
    expect(screen.getByText("LEVEL 7")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument(); // games played
    expect(screen.getByText("12")).toBeInTheDocument(); // games won
    expect(screen.getByText("48%")).toBeInTheDocument(); // win rate
    expect(screen.getByText("1250.00 USDC")).toBeInTheDocument(); // yield earned
    expect(screen.getByText("First Blood")).toBeInTheDocument();
    expect(screen.getByText("Cyber Clash Alpha")).toBeInTheDocument();
  });

  it("respects privacy setting hideHistory by concealing match history", () => {
    const privateProfile: PublicProfileData = {
      ...mockProfile,
      recentSettledArenas: [],
      privacy: {
        hideHistory: true,
        hideFromSearch: false,
      },
    };

    render(<PublicProfileView profile={privateProfile} />);

    expect(
      screen.getByText(/Match history is hidden by this player's privacy settings/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Cyber Clash Alpha")).not.toBeInTheDocument();
  });

  it("renders suspended state for banned or moderated players", () => {
    const bannedProfile: PublicProfileData = {
      ...mockProfile,
      isBanned: true,
    };

    render(<PublicProfileView profile={bannedProfile} />);

    expect(screen.getByText("ACCOUNT SUSPENDED")).toBeInTheDocument();
  });

  describe("generateMetadata", () => {
    beforeEach(() => {
      global.fetch = jest.fn();
    });

    it("sets robots index: false when hideFromSearch is enabled", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...mockProfile,
          privacy: { hideHistory: false, hideFromSearch: true },
        }),
      });

      const meta = await generateMetadata({
        params: Promise.resolve({ aliasOrAddress: "neon_shadow" }),
      });

      expect(meta.robots).toEqual({ index: false, follow: false });
      expect(meta.title).toContain("@neon_shadow");
    });
  });
});
