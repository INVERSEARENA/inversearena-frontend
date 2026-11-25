import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { TransactionModal } from "../TransactionModal";
import type { DecodedInvocationSummary } from "@/shared/lib/stellar/decodeInvocation";

jest.mock("@/components/ui/Modal", () => ({
  Modal: ({ children, isOpen, ariaLabel }: { children: React.ReactNode; isOpen: boolean; ariaLabel: string }) =>
    isOpen ? <div role="dialog" aria-label={ariaLabel}>{children}</div> : null,
}));

const verifiedPreview: DecodedInvocationSummary = {
  contractId: "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE",
  contractName: "Arena Contract",
  isKnownContract: true,
  functionName: "join",
  args: [
    { index: 0, label: "player", value: "GABC...", displayValue: "GABC..." },
    { index: 1, label: "amount", value: "100000000", displayValue: "100000000" },
  ],
  authEntries: [],
  tokenTransfers: [
    {
      tokenContractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      symbol: "USDC",
      decimals: 7,
      rawAmount: "100000000",
      formattedAmount: "10",
      from: "GABC...",
      to: "CA3D...",
    },
  ],
  feeStroops: "100000",
  feeXlm: "0.01",
  resourceLimits: { instructions: 500000, readBytes: 2048, writeBytes: 512 },
  warnings: [],
  isBlocked: false,
};

const blockedPreview: DecodedInvocationSummary = {
  ...verifiedPreview,
  contractName: "Unknown Contract",
  isKnownContract: false,
  warnings: ["Unknown target contract is not in the configured deployment manifest."],
  isBlocked: true,
};

describe("TransactionModal decoded preview (#1829)", () => {
  it("renders decoded preview details and enables confirm for verified contracts", () => {
    const onConfirm = jest.fn().mockResolvedValue(undefined);
    render(
      <TransactionModal
        isOpen={true}
        onClose={jest.fn()}
        title="Join Arena"
        details={[]}
        onConfirm={onConfirm}
        decodedPreview={verifiedPreview}
      />,
    );

    expect(screen.getByRole("region", { name: /decoded transaction invocation preview/i })).toBeInTheDocument();
    expect(screen.getByText("Arena Contract")).toBeInTheDocument();
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.getByText("join()")).toBeInTheDocument();
    expect(screen.getByText("10 USDC")).toBeInTheDocument();

    const toggleBtn = screen.getByRole("button", { name: /show auth & limits/i });
    fireEvent.click(toggleBtn);
    expect(screen.getByText(/CPU: 500,000/)).toBeInTheDocument();

    const confirmBtn = screen.getByRole("button", { name: /approve transaction/i });
    expect(confirmBtn).not.toBeDisabled();
  });

  it("displays blocking alert and disables signing for unknown contracts", () => {
    render(
      <TransactionModal
        isOpen={true}
        onClose={jest.fn()}
        title="Join Arena"
        details={[]}
        onConfirm={jest.fn()}
        decodedPreview={blockedPreview}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/Signing Blocked/i);
    const blockedBtn = screen.getByRole("button", { name: /signing blocked/i });
    expect(blockedBtn).toBeDisabled();
  });
});
