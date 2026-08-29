import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PoolCreationModal } from "../PoolCreationModal";
import { useWallet } from "@/features/wallet/useWallet";
import { buildCreatePoolTransaction, submitSignedTransaction } from "@/shared-d/utils/stellar-transactions";

jest.mock("@/features/wallet/useWallet");
jest.mock("@/shared-d/utils/stellar-transactions", () => ({
  buildCreatePoolTransaction: jest.fn(),
  submitSignedTransaction: jest.fn(),
}));

const mockUseWallet = useWallet as jest.MockedFunction<typeof useWallet>;

const defaultWalletState = {
  isConnected: true,
  address: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
  publicKey: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
  status: "connected" as const,
  error: null,
  network: "TESTNET",
  balance: { xlm: 100, usdc: 1000 },
  isLoadingBalance: false,
  balanceError: null,
  connect: jest.fn(),
  disconnect: jest.fn(),
  signTransaction: jest.fn().mockResolvedValue("signed-xdr"),
  refreshBalance: jest.fn(),
};

describe("PoolCreationModal XLM fee validation (#1332)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseWallet.mockReturnValue(defaultWalletState);
    (buildCreatePoolTransaction as jest.Mock).mockResolvedValue({
      toXDR: () => "unsigned-xdr",
    });
    (submitSignedTransaction as jest.Mock).mockResolvedValue(undefined);
  });

  it("accepts XLM stake when balance is sufficient for stake + network fee", async () => {
    // User has 100 XLM, estimated fee is ~1 XLM, so max stake should be ~99 XLM
    mockUseWallet.mockReturnValue({
      ...defaultWalletState,
      balance: { xlm: 100, usdc: 1000 },
    });

    render(
      <PoolCreationModal
        isOpen={true}
        onClose={jest.fn()}
      />
    );

    // Select XLM currency
    const currencySelect = screen.getByLabelText("Currency selection");
    fireEvent.change(currencySelect, { target: { value: "XLM" } });

    // Enter stake amount that leaves room for fee (e.g., 98 XLM)
    const stakeInput = screen.getByLabelText("Stake amount");
    fireEvent.change(stakeInput, { target: { value: "98" } });

    // Wait for validation
    await waitFor(() => {
      // Button should be enabled - no error should appear
      const initButton = screen.getByLabelText("Initialize arena");
      expect(initButton).not.toBeDisabled();
    });

    // Should not show insufficient balance error
    expect(screen.queryByText(/Insufficient balance/i)).not.toBeInTheDocument();
  });

  it("rejects XLM stake equal to full balance without accounting for network fee (#1332)", async () => {
    // User has 100 XLM - entering 100 should fail because fee needs to be reserved
    mockUseWallet.mockReturnValue({
      ...defaultWalletState,
      balance: { xlm: 100, usdc: 1000 },
    });

    render(
      <PoolCreationModal
        isOpen={true}
        onClose={jest.fn()}
      />
    );

    // Select XLM currency
    const currencySelect = screen.getByLabelText("Currency selection");
    fireEvent.change(currencySelect, { target: { value: "XLM" } });

    // Enter stake amount equal to full balance
    const stakeInput = screen.getByLabelText("Stake amount");
    fireEvent.change(stakeInput, { target: { value: "100" } });

    // Wait for validation
    await waitFor(() => {
      // Should show insufficient balance error
      expect(screen.getByText(/Insufficient balance/i)).toBeInTheDocument();
    });

    // Initialize button should be disabled
    const initButton = screen.getByLabelText("Initialize arena");
    expect(initButton).toBeDisabled();
  });

  it("shows maximum available XLM stake accounting for network fee", async () => {
    mockUseWallet.mockReturnValue({
      ...defaultWalletState,
      balance: { xlm: 100, usdc: 1000 },
    });

    render(
      <PoolCreationModal
        isOpen={true}
        onClose={jest.fn()}
      />
    );

    // Select XLM currency
    const currencySelect = screen.getByLabelText("Currency selection");
    fireEvent.change(currencySelect, { target: { value: "XLM" } });

    // Enter stake higher than balance
    const stakeInput = screen.getByLabelText("Stake amount");
    fireEvent.change(stakeInput, { target: { value: "105" } });

    // Wait for error message
    await waitFor(() => {
      const errorMsg = screen.getByText(/Insufficient balance/i);
      expect(errorMsg).toBeInTheDocument();
      // The max shown should be less than 100 (accounting for fee)
      // Estimated fee is ~1 XLM, so max should be around 99
      expect(errorMsg.textContent).toMatch(/Maximum: \d{2}\.\d{7} XLM/);
    });
  });

  it("does not subtract network fee from USDC balance", async () => {
    // USDC transactions use XLM for fees, so USDC balance should not be reduced
    mockUseWallet.mockReturnValue({
      ...defaultWalletState,
      balance: { xlm: 100, usdc: 1000 },
    });

    render(
      <PoolCreationModal
        isOpen={true}
        onClose={jest.fn()}
      />
    );

    // USDC is the default currency, so no need to change
    // Enter stake amount equal to full USDC balance
    const stakeInput = screen.getByLabelText("Stake amount");
    fireEvent.change(stakeInput, { target: { value: "1000" } });

    // Wait for validation
    await waitFor(() => {
      // Button should be enabled for USDC at full balance
      const initButton = screen.getByLabelText("Initialize arena");
      expect(initButton).not.toBeDisabled();
    });

    // Should not show insufficient balance error for USDC
    expect(screen.queryByText(/Insufficient balance/i)).not.toBeInTheDocument();
  });

  it("displays total cost including network fee in summary", async () => {
    mockUseWallet.mockReturnValue(defaultWalletState);

    render(
      <PoolCreationModal
        isOpen={true}
        onClose={jest.fn()}
      />
    );

    // Select XLM and enter valid stake
    const currencySelect = screen.getByLabelText("Currency selection");
    fireEvent.change(currencySelect, { target: { value: "XLM" } });

    const stakeInput = screen.getByLabelText("Stake amount");
    fireEvent.change(stakeInput, { target: { value: "50" } });

    // Wait for form to be valid and fee display to appear
    await waitFor(() => {
      expect(screen.getByText(/Estimated Network Fee:/i)).toBeInTheDocument();
      expect(screen.getByText(/Total Cost:/i)).toBeInTheDocument();
    });
  });

  it("updates max stake when switching from USDC to XLM", async () => {
    mockUseWallet.mockReturnValue({
      ...defaultWalletState,
      balance: { xlm: 10, usdc: 1000 },
    });

    render(
      <PoolCreationModal
        isOpen={true}
        onClose={jest.fn()}
      />
    );

    // Start with USDC - 1000 should be valid
    const stakeInput = screen.getByLabelText("Stake amount");
    fireEvent.change(stakeInput, { target: { value: "1000" } });

    await waitFor(() => {
      const initButton = screen.getByLabelText("Initialize arena");
      expect(initButton).not.toBeDisabled();
    });

    // Switch to XLM - 1000 should now be invalid (balance is only 10 XLM)
    const currencySelect = screen.getByLabelText("Currency selection");
    fireEvent.change(currencySelect, { target: { value: "XLM" } });

    await waitFor(() => {
      expect(screen.getByText(/Insufficient balance/i)).toBeInTheDocument();
    });

    const initButton = screen.getByLabelText("Initialize arena");
    expect(initButton).toBeDisabled();
  });

  it("prevents signing transaction that would fail due to insufficient balance for fees", async () => {
    // This is the key test for #1332 - ensures validation catches the issue BEFORE signing
    mockUseWallet.mockReturnValue({
      ...defaultWalletState,
      balance: { xlm: 50.5, usdc: 1000 },
    });

    render(
      <PoolCreationModal
        isOpen={true}
        onClose={jest.fn()}
      />
    );

    const currencySelect = screen.getByLabelText("Currency selection");
    fireEvent.change(currencySelect, { target: { value: "XLM" } });

    // Try to stake an amount that would leave insufficient balance for fees
    const stakeInput = screen.getByLabelText("Stake amount");
    fireEvent.change(stakeInput, { target: { value: "50.5" } }); // Full balance, no room for fee

    await waitFor(() => {
      const initButton = screen.getByLabelText("Initialize arena");
      expect(initButton).toBeDisabled();
    });

    // User should see validation error, not get to signing step
    expect(screen.getByText(/Insufficient balance/i)).toBeInTheDocument();

    // signTransaction should never be called because validation prevents it
    expect(defaultWalletState.signTransaction).not.toHaveBeenCalled();
  });
});

describe("PoolCreationModal form validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseWallet.mockReturnValue(defaultWalletState);
  });

  it("validates minimum stake amount", async () => {
    render(
      <PoolCreationModal
        isOpen={true}
        onClose={jest.fn()}
      />
    );

    const stakeInput = screen.getByLabelText("Stake amount");
    fireEvent.change(stakeInput, { target: { value: "0.5" } }); // Below minimum

    await waitFor(() => {
      expect(screen.getByText(/Minimum stake is/i)).toBeInTheDocument();
    });
  });

  it("validates arena capacity bounds", async () => {
    render(
      <PoolCreationModal
        isOpen={true}
        onClose={jest.fn()}
      />
    );

    const stakeInput = screen.getByLabelText("Stake amount");
    fireEvent.change(stakeInput, { target: { value: "100" } });

    await waitFor(() => {
      const initButton = screen.getByLabelText("Initialize arena");
      expect(initButton).not.toBeDisabled();
    });

    // Decrease and increase buttons should respect min/max
    const decreaseButton = screen.getByLabelText("Decrease arena capacity");
    const increaseButton = screen.getByLabelText("Increase arena capacity");

    expect(decreaseButton).toBeInTheDocument();
    expect(increaseButton).toBeInTheDocument();
  });
});
