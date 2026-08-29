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
import {
  formatCurrencyInput,
  sanitizeNumericInput,
} from "@/shared-d/utils/form-validation";

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

/**
 * Regression tests for #1340.
 *
 * handleAmountChange used to strip characters with /[^0-9.]/g, which permits
 * any number of decimal points. Typing "12..34" left "12..34" visible in the
 * field while parseFloat("12..34") returns 12 — and that 12 is what drove
 * validation, the enabled state, and the transaction that got built. The
 * amount actually submitted silently diverged from the amount on screen.
 *
 * StakeModal now routes input through sanitizeNumericInput/formatCurrencyInput
 * from form-validation.ts, the same helpers PoolCreationModal uses.
 */
describe("StakeModal numeric input normalisation (#1340)", () => {
  function renderWithBalance(xlm = 10_000) {
    Object.assign(walletState, baseWallet({ balance: { xlm, usdc: 0 } }));
    render(<StakeModal isOpen onClose={jest.fn()} />);
    return screen.getByPlaceholderText("0.00") as HTMLInputElement;
  }

  it('normalises "12..34" instead of displaying it verbatim', () => {
    const input = renderWithBalance();

    fireEvent.change(input, { target: { value: "12..34" } });

    // The field must never show a value that parseFloat would read as
    // something else. Previously this rendered "12..34" while the modal
    // used 12.
    expect(input.value).not.toBe("12..34");
    expect(input.value).toBe("12.34");
    expect(parseFloat(input.value)).toBeCloseTo(12.34, 5);
  });

  it("keeps the displayed value and the parsed amount in agreement", () => {
    const input = renderWithBalance();

    for (const typed of ["12..34", "1.2.3", "5....5", "0..1"]) {
      fireEvent.change(input, { target: { value: typed } });

      // The invariant that #1340 broke: what the user sees is what gets
      // staked.
      expect(String(parseFloat(input.value))).toBe(input.value);
    }
  });

  it("strips non-numeric characters and negative signs", () => {
    const input = renderWithBalance();

    fireEvent.change(input, { target: { value: "1a2b3c" } });
    expect(input.value).toBe("123");

    fireEvent.change(input, { target: { value: "-50" } });
    expect(input.value).toBe("50");
  });

  it("limits decimals to XLM's 7-digit precision", () => {
    const input = renderWithBalance();

    fireEvent.change(input, { target: { value: "1.123456789" } });

    expect(input.value).toBe("1.1234567");
  });

  it("still accepts ordinary well-formed amounts unchanged", () => {
    const input = renderWithBalance();

    for (const typed of ["100", "0.5", "1234.56"]) {
      fireEvent.change(input, { target: { value: typed } });
      expect(input.value).toBe(typed);
    }
  });

  it("normalises multi-dot input the same way PoolCreationModal does", () => {
    const input = renderWithBalance();

    fireEvent.change(input, { target: { value: "12..34" } });

    // PoolCreationModal pipes input through the identical helpers, so both
    // modals must agree on the normalised result.
    const viaSharedHelpers = formatCurrencyInput(
      sanitizeNumericInput("12..34"),
      "XLM",
    );
    expect(input.value).toBe(viaSharedHelpers);
  });
});
