import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AnalysisPage from "../page";

// next/navigation stub (page reads `arena` from URL query params, #1568)
jest.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: () => null }),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

const series = {
  arenaId: "arena-1",
  asset: "USDC",
  assetDecimals: 6,
  points: [
    { round: 1, timestamp: "2026-01-01T00:00:00.000Z", rateBps: "500", accrued: "5.000000", cumulative: "5.000000" },
    { round: 2, timestamp: "2026-01-02T00:00:00.000Z", rateBps: "250", accrued: "2.500000", cumulative: "7.500000" },
  ],
  nextCursor: null,
  hasMore: false,
  finished: false,
};

describe("AnalysisPage (#1568)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    Object.defineProperty(window, "localStorage", {
      value: { getItem: jest.fn(() => null) },
      writable: true,
    });
  });

  it("prompts for an arena id when none is selected", () => {
    render(<AnalysisPage />);
    expect(screen.getByLabelText(/arena id/i)).toBeInTheDocument();
    expect(screen.getByText(/enter an arena id above/i)).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("loads the per-arena series and renders real points", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => series });
    render(<AnalysisPage />);

    fireEvent.change(screen.getByLabelText(/arena id/i), {
      target: { value: "arena-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^load$/i }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/api/arenas/arena-1/yield");

    // Event log lists the snapshot earnings (newest first).
    await waitFor(() => {
      expect(screen.getByText("+2.500000")).toBeInTheDocument();
      expect(screen.getByText("+5.000000")).toBeInTheDocument();
    });
  });

  it("shows an error with retry when the series fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    render(<AnalysisPage />);

    fireEvent.change(screen.getByLabelText(/arena id/i), {
      target: { value: "missing" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^load$/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });
  });
});
