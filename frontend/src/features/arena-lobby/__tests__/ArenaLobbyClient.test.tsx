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
  address: WALLET_ADDRESS,
  isConnected: true,
  status: "connected" as const,
  error: null,
  network: "TESTNET",
  balance: { xlm: 0, usdc: 0 },
  isLoadingBalance: false,
  balanceError: null,
  connect: jest.fn().mockResolvedValue(WALLET_ADDRESS),
  disconnect: jest.fn(),
  signTransaction: jest.fn(),
  refreshBalance: jest.fn().mockResolvedValue(undefined),
};

jest.mock("@/features/wallet/useWallet", () => ({
  useWallet: () => walletMock,
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
      );
    });
    expect(walletMock.signTransaction).toHaveBeenCalledWith("unsigned-xdr");
    expect(submitSignedTransaction).toHaveBeenCalledWith("signed-xdr");
  });

  it("reflects a wallet connected via the shared context, not an independent hook instance (#1282)", async () => {
    // Before the fix, this component called useStellarWallet(...) directly,
    // holding its own local connection state disconnected from the
    // context-backed ConnectWalletButton in the header — a genuinely
    // connected user would still see "Wallet Required" here. Using the
    // shared useWallet() context (mocked above) means this component's
    // "connected" state comes from the same source the header uses.
    render(
      <ArenaLobbyClient
        arenaId="arena-1"
        initialStats={STATS}
        initialParticipants={[]}
        initialNextCursor={null}
      />,
    );

    const joinButton = await screen.findByRole("button", { name: "Join Arena" });
    expect(joinButton).not.toHaveTextContent("Wallet Required");
  });

  it("renders a hidden placeholder instead of crashing when the backend masks an open round's choice (#1212)", async () => {
    // The backend now returns choice: null for any round still OPEN, so
    // other players can't see how someone voted before the round closes.
    // This asserts the frontend renders that as a placeholder rather than
    // crashing on participant.choice.toUpperCase().
    render(
      <ArenaLobbyClient
        arenaId="arena-1"
        initialStats={STATS}
        initialParticipants={[
          {
            id: "round-1:user-1:0",
            walletAddress: "GUSER1",
            choice: null,
            stake: 100,
            status: "READY",
            roundNumber: 1,
            joinedAt: new Date().toISOString(),
          },
        ]}
        initialNextCursor={null}
      />,
    );

    const hidden = await screen.findByText("HIDDEN");
    expect(hidden).toBeInTheDocument();

    // The participant row is the only place that should render this
    // wallet's choice — scope to it, since "HEADS" also appears
    // unconditionally as a static vote-button label in <ChoiceSubmission>
    // elsewhere on the page.
    const participantRow = hidden.closest("div.grid") as HTMLElement;
    expect(participantRow).not.toBeNull();
    expect(participantRow).toHaveTextContent("GUSER1");
    expect(participantRow).not.toHaveTextContent("HEADS");
    expect(participantRow).not.toHaveTextContent("TAILS");
  });

  it("allows joining and choice submission when joinDeadline is null (open-ended arena) (#1334)", async () => {
    // An arena with joinDeadline: null is open-ended and should always
    // allow joining and choice submission while the arena status is "open"
    const openEndedStats = {
      ...STATS,
      joinDeadline: null,
    };

    render(
      <ArenaLobbyClient
        arenaId="arena-1"
        initialStats={openEndedStats}
        initialParticipants={[]}
        initialNextCursor={null}
      />,
    );

    // Join button should be enabled for open-ended arenas
    const joinButton = await screen.findByRole("button", { name: "Join Arena" });
    expect(joinButton).toBeEnabled();
    expect(joinButton).toHaveTextContent("Join Arena");

    // Countdown should show "No deadline"
    expect(screen.getByText("No deadline")).toBeInTheDocument();

    // Choice submission should also show "No deadline" and be enabled
    expect(screen.getByText(/Submission deadline/i)).toBeInTheDocument();
  });

  it("disables joining when joinDeadline has passed", async () => {
    // An arena with a past deadline should disable joining
    const pastDeadlineStats = {
      ...STATS,
      joinDeadline: new Date(Date.now() - 60_000).toISOString(),
    };

    render(
      <ArenaLobbyClient
        arenaId="arena-1"
        initialStats={pastDeadlineStats}
        initialParticipants={[]}
        initialNextCursor={null}
      />,
    );

    const joinButton = await screen.findByRole("button", { name: "Join Unavailable" });
    expect(joinButton).toBeDisabled();
  });
});
