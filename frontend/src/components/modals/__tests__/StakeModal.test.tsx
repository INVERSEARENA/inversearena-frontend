/**
 * Regression test for #1295 (downstream half).
 *
 * StakeModal's "Insufficient balance" guard reads WalletProvider's balance.
 * When a balance lookup failed, that balance used to silently be 0, so the
 * modal blocked every stake with a misleading "Insufficient balance" error.
 * It must instead show a retry affordance and not claim the wallet is short
 * on funds.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";

import StakeModal from "../StakeModal";

const walletState: Record<string, unknown> = {};

jest.mock("@/features/wallet/useWallet", () => ({
  useWallet: () => walletState,
}));

jest.mock("@/shared-d/utils/stellar-transactions", () => ({
  STAKING_CONTRACT_ID: `C${"A".repeat(55)}`,
  STELLAR_PLACEHOLDERS: { stakingContractId: "PLACEHOLDER_STAKING_CONTRACT_ID" },
  buildStakeProtocolTransaction: jest.fn(),
  submitSignedTransaction: jest.fn(),
  parseStellarError: (err: unknown) => String(err),
}));

const VALID_KEY = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

function baseWallet(overrides: Record<string, unknown> = {}) {
  return {
    address: VALID_KEY,
    isConnected: true,
    connect: jest.fn(),
    signTransaction: jest.fn(),
    balance: { xlm: 0, usdc: 0 },
    isLoadingBalance: false,
    balanceError: null,
    refreshBalance: jest.fn(),
    ...overrides,
  };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe("StakeModal balance-load failure (#1295)", () => {
  it("shows a retry affordance and no 'Insufficient balance' when the balance failed to load", () => {
    Object.assign(
      walletState,
      baseWallet({ balanceError: "Horizon returned HTTP 503 while fetching XLM balance" }),
    );

    render(<StakeModal isOpen onClose={jest.fn()} />);

    expect(screen.getByText(/couldn't load your wallet balance/i)).toBeInTheDocument();
    expect(screen.getByText(/balance: unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/insufficient balance/i)).not.toBeInTheDocument();

    // Primary action is blocked until the balance is known.
    expect(screen.getByRole("button", { name: /initiate stake/i })).toBeDisabled();
  });

  it("RETRY triggers a balance refresh", () => {
    const refreshBalance = jest.fn();
    Object.assign(
      walletState,
      baseWallet({ balanceError: "network error", refreshBalance }),
    );

    render(<StakeModal isOpen onClose={jest.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(refreshBalance).toHaveBeenCalledTimes(1);
  });

  it("still allows staking normally when the balance loaded fine", () => {
    Object.assign(
      walletState,
      baseWallet({ balance: { xlm: 10000, usdc: 0 }, balanceError: null }),
    );

    render(<StakeModal isOpen onClose={jest.fn()} />);

    expect(screen.queryByText(/couldn't load your wallet balance/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /initiate stake/i })).not.toBeDisabled();
  });
});
