import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DownloadReceiptButton } from "../DownloadReceiptButton";

describe("DownloadReceiptButton", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    // jsdom doesn't implement these; the component calls them on a successful download.
    global.URL.createObjectURL = jest.fn().mockReturnValue("blob:mock");
    global.URL.revokeObjectURL = jest.fn();
  });

  it("triggers a CSV download on click", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["csv,data"], { type: "text/csv" }),
    });

    render(<DownloadReceiptButton payoutId="payout-1" accessToken="token-abc" />);
    fireEvent.click(screen.getByRole("button", { name: /receipt/i }));

    await waitFor(() => expect(global.URL.createObjectURL).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/payouts/payout-1/receipt.csv"),
      expect.objectContaining({ headers: { Authorization: "Bearer token-abc" } }),
    );
  });

  it("shows an inline error instead of throwing when the payout is not settled yet", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 409 });

    render(<DownloadReceiptButton payoutId="payout-1" />);
    fireEvent.click(screen.getByRole("button", { name: /receipt/i }));

    expect(await screen.findByText(/not settled yet/i)).toBeInTheDocument();
  });

  it("shows an inline error when the receipt is not found", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });

    render(<DownloadReceiptButton payoutId="payout-1" />);
    fireEvent.click(screen.getByRole("button", { name: /receipt/i }));

    expect(await screen.findByText(/receipt not found/i)).toBeInTheDocument();
  });

  it("does not crash when the fetch itself rejects (network error)", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("offline"));

    render(<DownloadReceiptButton payoutId="payout-1" />);
    fireEvent.click(screen.getByRole("button", { name: /receipt/i }));

    expect(await screen.findByText("offline")).toBeInTheDocument();
  });
});
