import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChoiceSubmission } from "../ChoiceSubmission";
import {
  buildSubmitCommitmentTransaction,
  submitSignedTransaction,
} from "@/shared-d/utils/stellar-transactions";

jest.mock("@/shared-d/utils/stellar-transactions", () => ({
  buildSubmitCommitmentTransaction: jest.fn(),
  submitSignedTransaction: jest.fn(),
}));

const WALLET_ADDRESS = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

const mockWallet = {
  publicKey: WALLET_ADDRESS,
  isConnected: true,
  status: "connected" as const,
  connectWallet: jest.fn().mockResolvedValue(WALLET_ADDRESS),
  signTransaction: jest.fn().mockResolvedValue("signed-xdr"),
};

describe("ChoiceSubmission", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (buildSubmitCommitmentTransaction as jest.Mock).mockResolvedValue({
      toXDR: () => "unsigned-xdr",
    });
    (submitSignedTransaction as jest.Mock).mockResolvedValue(undefined);
  });

  it("renders choice buttons and allows selection when arena is open with a deadline", async () => {
    const futureDeadline = new Date(Date.now() + 300_000).toISOString();

    render(
      <ChoiceSubmission
        arenaId="arena-1"
        roundNumber={1}
        deadline={futureDeadline}
        arenaStatus="open"
        wallet={mockWallet}
      />,
    );

    const headsButton = screen.getByRole("button", { name: /Submit Heads choice/i });
    const tailsButton = screen.getByRole("button", { name: /Submit Tails choice/i });

    expect(headsButton).toBeEnabled();
    expect(tailsButton).toBeEnabled();
  });

  it("allows choice submission when joinDeadline is null (open-ended arena) (#1334)", async () => {
    // When deadline is an empty string (passed from null joinDeadline),
    // the component should treat it as "no deadline" and allow submission
    render(
      <ChoiceSubmission
        arenaId="arena-1"
        roundNumber={1}
        deadline=""
        arenaStatus="open"
        wallet={mockWallet}
      />,
    );

    // Buttons should be enabled
    const headsButton = screen.getByRole("button", { name: /Submit Heads choice/i });
    const tailsButton = screen.getByRole("button", { name: /Submit Tails choice/i });

    expect(headsButton).toBeEnabled();
    expect(tailsButton).toBeEnabled();

    // Should show "No deadline" instead of "00:00"
    expect(screen.getByText("No deadline")).toBeInTheDocument();

    // Should allow submission
    fireEvent.click(headsButton);

    await waitFor(() => {
      expect(buildSubmitCommitmentTransaction).toHaveBeenCalledWith(
        WALLET_ADDRESS,
        "arena-1",
        "Heads",
        1,
      );
    });

    expect(mockWallet.signTransaction).toHaveBeenCalledWith("unsigned-xdr");
    expect(submitSignedTransaction).toHaveBeenCalledWith("signed-xdr");
  });

  it("disables choice submission when deadline has passed", async () => {
    const pastDeadline = new Date(Date.now() - 60_000).toISOString();

    render(
      <ChoiceSubmission
        arenaId="arena-1"
        roundNumber={1}
        deadline={pastDeadline}
        arenaStatus="open"
        wallet={mockWallet}
      />,
    );

    const headsButton = screen.getByRole("button", { name: /Submit Heads choice/i });
    const tailsButton = screen.getByRole("button", { name: /Submit Tails choice/i });

    expect(headsButton).toBeDisabled();
    expect(tailsButton).toBeDisabled();

    expect(screen.getByText("Submission window closed")).toBeInTheDocument();
  });

  it("disables choice submission when arena is not open", async () => {
    render(
      <ChoiceSubmission
        arenaId="arena-1"
        roundNumber={1}
        deadline=""
        arenaStatus="closed"
        wallet={mockWallet}
      />,
    );

    const headsButton = screen.getByRole("button", { name: /Submit Heads choice/i });
    const tailsButton = screen.getByRole("button", { name: /Submit Tails choice/i });

    expect(headsButton).toBeDisabled();
    expect(tailsButton).toBeDisabled();

    expect(screen.getByText("Arena is not open")).toBeInTheDocument();
  });

  it("shows correct countdown formatting for various time ranges", () => {
    jest.useFakeTimers();
    const now = Date.now();

    // 5 minutes remaining
    const fiveMinutes = new Date(now + 5 * 60 * 1000).toISOString();
    const { rerender } = render(
      <ChoiceSubmission
        arenaId="arena-1"
        roundNumber={1}
        deadline={fiveMinutes}
        arenaStatus="open"
        wallet={mockWallet}
      />,
    );

    expect(screen.getByText(/05:00/)).toBeInTheDocument();

    // No deadline
    rerender(
      <ChoiceSubmission
        arenaId="arena-1"
        roundNumber={1}
        deadline=""
        arenaStatus="open"
        wallet={mockWallet}
      />,
    );

    expect(screen.getByText("No deadline")).toBeInTheDocument();

    jest.useRealTimers();
  });

  it("displays wallet connection status correctly", () => {
    const disconnectedWallet = {
      ...mockWallet,
      publicKey: null,
      isConnected: false,
      status: "disconnected" as const,
    };

    render(
      <ChoiceSubmission
        arenaId="arena-1"
        roundNumber={1}
        deadline=""
        arenaStatus="open"
        wallet={disconnectedWallet}
      />,
    );

    expect(screen.getByText("Wallet not connected")).toBeInTheDocument();
  });

  it("handles submission errors gracefully", async () => {
    (buildSubmitCommitmentTransaction as jest.Mock).mockRejectedValueOnce(
      new Error("Transaction build failed"),
    );

    render(
      <ChoiceSubmission
        arenaId="arena-1"
        roundNumber={1}
        deadline=""
        arenaStatus="open"
        wallet={mockWallet}
      />,
    );

    const headsButton = screen.getByRole("button", { name: /Submit Heads choice/i });
    fireEvent.click(headsButton);

    await waitFor(() => {
      expect(screen.getByText("Transaction build failed")).toBeInTheDocument();
    });

    // Should show retry button
    const retryButton = screen.getByRole("button", { name: /Retry/i });
    expect(retryButton).toBeInTheDocument();
  });
});
