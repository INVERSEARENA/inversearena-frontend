import { render, screen, waitFor } from "@testing-library/react";
import { MaintenanceBanner } from "../MaintenanceBanner";

describe("MaintenanceBanner", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("renders nothing when maintenance is not active", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ active: false, currentLedgerSequence: 100, window: null }),
    });

    const { container } = render(<MaintenanceBanner />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the reason and end ledger when a window is active", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        active: true,
        currentLedgerSequence: 500,
        window: { id: "win-1", endLedgerSequence: 700, reason: "Contract upgrade" },
      }),
    });

    render(<MaintenanceBanner />);

    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByText(/Contract upgrade/)).toBeInTheDocument();
    expect(screen.getByText(/ledger 700/)).toBeInTheDocument();
  });

  it("renders an indefinite window without a ledger number", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        active: true,
        currentLedgerSequence: 500,
        window: { id: "win-1", endLedgerSequence: null, reason: "Emergency pause" },
      }),
    });

    render(<MaintenanceBanner />);

    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByText(/Emergency pause/)).toBeInTheDocument();
    expect(screen.queryByText(/ledger/)).not.toBeInTheDocument();
  });

  it("does not throw and shows nothing when the status fetch fails", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network error"));

    const { container } = render(<MaintenanceBanner />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
