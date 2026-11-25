import React from "react";
import { render, screen } from "@testing-library/react";
import { ArenaStatsSkeleton } from "../ArenaStatsSkeleton";

describe("ArenaStatsSkeleton (#669)", () => {
  it("renders a labelled skeleton placeholder", () => {
    render(<ArenaStatsSkeleton />);
    expect(screen.getByTestId("arena-stats-skeleton")).toBeInTheDocument();
  });

  it("renders shimmer placeholders for the stats cards", () => {
    const { container } = render(<ArenaStatsSkeleton />);
    // Skeleton uses the animate-pulse shimmer class.
    const shimmers = container.querySelectorAll(".animate-pulse");
    expect(shimmers.length).toBeGreaterThan(4);
  });

  it("is hidden from assistive tech while loading", () => {
    render(<ArenaStatsSkeleton />);
    expect(screen.getByTestId("arena-stats-skeleton")).toHaveAttribute("aria-hidden", "true");
  });
});
