import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ArenaLobbyClient } from "../ArenaLobbyClient";
import {
  buildJoinArenaTransaction,
  submitSignedTransaction,
} from "@/shared-d/utils/stellar-transactions";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

const WALLET_ADDRESS = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

const walletMock = {
  publicKey: WALLET_ADDRESS,
  isConnected: true,
  status: "connected" as const,
  error: null,
  connectWallet: jest.fn(),
  signTransaction: jest.fn(),
  disconnectWallet: jest.fn(),
};

jest.mock("@/features/wallet/useStellarWallet", () => ({
  useStellarWallet: () => walletMock,
}));

jest.mock("@/shared-d/utils/stellar-transactions", () => ({
  buildJoinArenaTransaction: jest.fn(),
  buildSubmitChoiceTransaction: jest.fn(),
  submitSignedTransaction: jest.fn(),
  parseStellarError: (err: unknown) => (err instanceof Error ? err.message : "Unknown error"),
}));

const STATS = {
  arenaId: "arena-1",
  arenaName: "Alpha Arena",
  currentPot: 1000,
  playerCount: 10,
  maxPlayers: 100,
  survivorCount: 10,
  currentRound: 1,
  entryFee: 100,
  stakeToken: "XLM",
  joinDeadline: new Date(Date.now() + 60_000).toISOString(),
  yieldAccrued: 5,
  status: "open",
  lastUpdated: new Date().toISOString(),
};

function mockFetchOnce(response: unknown) {
  return { ok: true, json: async () => response } as Response;
}

describe("ArenaLobbyClient join flow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    walletMock.signTransaction.mockResolvedValue("signed-xdr");
    (buildJoinArenaTransaction as jest.Mock).mockResolvedValue({
      toXDR: () => "unsigned-xdr",
    });
    (submitSignedTransaction as jest.Mock).mockResolvedValue(undefined);

    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes("/participants")) {
        return Promise.resolve(
          mockFetchOnce({ arenaId: "arena-1", total: 0, nextCursor: null, hasMore: false, items: [] }),
        );
      }
      return Promise.resolve(mockFetchOnce(STATS));
    });
  });

  it("builds, signs, and submits a real join transaction when the CTA is confirmed", async () => {
    render(
      <ArenaLobbyClient
        arenaId="arena-1"
        initialStats={STATS}
        initialParticipants={[]}
        initialNextCursor={null}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Join Arena" }));

    // The modal overlay is marked aria-hidden on an ancestor, so role
    // queries need `hidden: true` to see inside it (plain DOM debugging
    // still shows the content — only accessible-role queries filter it).
    const signButton = await screen.findByRole("button", {
      name: /sign & join/i,
      hidden: true,
    });
    fireEvent.click(signButton);

    await waitFor(() => {
      expect(buildJoinArenaTransaction).toHaveBeenCalledWith(
        WALLET_ADDRESS,
        "arena-1",
        STATS.entryFee,
      );
    });
    expect(walletMock.signTransaction).toHaveBeenCalledWith("unsigned-xdr");
    expect(submitSignedTransaction).toHaveBeenCalledWith("signed-xdr");
  });
});
