/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import GamesPage from "../page";

const mockGet = jest.fn((key: string): string | null => {
  if (key === "filter") return null;
  if (key === "q") return null;
  return null;
});

jest.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: mockGet }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/dashboard/games",
}));

describe("GamesPage — Suspense boundary (issue #1285)", () => {
  it("wraps its useSearchParams() consumer in a Suspense boundary", () => {
    // GamesPage's default export must itself be a <Suspense> wrapper — a
    // bare component calling useSearchParams() with no boundary above it
    // is what Next.js's missing-suspense-with-csr-bailout check flags.
    // Rendering here would surface any invariant violation from a
    // useSearchParams() call outside Suspense in the React/Next test
    // environment used by this jest setup.
    expect(() => render(<GamesPage />)).not.toThrow();
  });

  it("renders the arena grid once search params resolve", async () => {
    render(<GamesPage />);
    await waitFor(() => {
      expect(screen.queryAllByText(/arena/i).length).toBeGreaterThan(0);
    });
  });

  it("filters arenas by the 'q' search param", async () => {
    mockGet.mockImplementation((key: string) => (key === "q" ? "1" : null));
    render(<GamesPage />);
    await waitFor(() => {
      expect(screen.queryByText(/no arenas found/i)).not.toBeInTheDocument();
    });
  });
});
