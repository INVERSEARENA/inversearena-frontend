import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { JoinFundingPanel } from "../JoinFundingPanel";
import type { PathQuote } from "@/shared/lib/stellar/path-payment-quote";

const ISSUER = "GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL";
const OTHER_ISSUER = "GAH56BOV3GTOGRM3UVDSUXWMGWAJNVYQ5FMMSKBYAHSOFRUOUTCIU3FO";

function makeQuote(expiresAt = Date.now() + 30_000): PathQuote {
  return {
    sourceAsset: { kind: "native", code: "XLM" },
    destinationAsset: { kind: "credit", code: "USDC", issuer: ISSUER },
    sourceAmount: "12.3000000",
    destinationAmount: "10.0000000",
    sendMax: "12.4230000",
    path: [{ kind: "credit", code: "EURC", issuer: OTHER_ISSUER }],
    slippageBps: 100,
    createdAt: Date.now(),
    expiresAt,
  };
}

const baseProps = {
  sourceAssets: [
    { kind: "native" as const, code: "XLM" as const },
    { kind: "credit" as const, code: "USDC" as const, issuer: ISSUER },
  ],
  selectedSourceCode: "XLM",
  onSelectSource: jest.fn(),
  quote: makeQuote(),
  isQuoting: false,
  error: null,
  fundingMode: "bundled" as const,
  preferTwoStep: false,
  onToggleTwoStep: jest.fn(),
  networkFeeStroops: "10000",
  onRetry: jest.fn(),
};

describe("JoinFundingPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows the exact swap parameters a player is asked to sign", () => {
    render(<JoinFundingPanel {...baseProps} />);

    expect(screen.getByLabelText("Join funding asset")).toHaveValue("XLM");
    expect(screen.getByText("12.3000000 XLM")).toBeTruthy();
    expect(screen.getByText("10.0000000 USDC")).toBeTruthy();
    expect(screen.getByText("EURC")).toBeTruthy();
    expect(screen.getByText("1%")).toBeTruthy();
    expect(screen.getByText("12.4230000 XLM")).toBeTruthy();
    expect(screen.getByText("0.0010000 XLM")).toBeTruthy();
  });

  it("lets the player switch back to a direct stake-token join", () => {
    render(<JoinFundingPanel {...baseProps} />);

    fireEvent.change(screen.getByLabelText("Join funding asset"), {
      target: { value: "direct" },
    });

    expect(baseProps.onSelectSource).toHaveBeenCalledWith(null);
  });

  it("marks an expired quote as stale and offers a refresh", () => {
    render(
      <JoinFundingPanel
        {...baseProps}
        quote={makeQuote(Date.now() - 1)}
      />,
    );

    expect(screen.getByRole("alert").textContent).toMatch(/expired/i);
    fireEvent.click(screen.getByRole("button", { name: /refresh quote/i }));
    expect(baseProps.onRetry).toHaveBeenCalledTimes(1);
  });

  it("offers an explicit two-step mode and explains it once selected", () => {
    render(
      <JoinFundingPanel {...baseProps} preferTwoStep fundingMode="two_step" />,
    );

    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByText(/two resumable steps/i)).toBeTruthy();
  });
});
