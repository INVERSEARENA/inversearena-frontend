import React from "react";
import { render, screen } from "@testing-library/react";
import { RankBadge } from "../RankBadge";

describe("RankBadge (#662)", () => {
  it("renders the rank number", () => {
    render(<RankBadge rank={5} />);
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("applies medal styling to the top three ranks", () => {
    const { container: first } = render(<RankBadge rank={1} />);
    const { container: tenth } = render(<RankBadge rank={10} />);
    // Rank 1 gets the gold medal colour; rank 10 does not.
    expect(first.querySelector('[class*="FFD700"]')).not.toBeNull();
    expect(tenth.querySelector('[class*="FFD700"]')).toBeNull();
  });

  it("shows no movement indicator by default", () => {
    render(<RankBadge rank={4} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("shows an animated up indicator when the rank improved", () => {
    render(<RankBadge rank={2} movement="up" />);
    const indicator = screen.getByRole("img", { name: /moved up/i });
    expect(indicator).toBeInTheDocument();
    expect(indicator.className).toMatch(/animate-in/);
  });

  it("shows a down indicator when the rank dropped", () => {
    render(<RankBadge rank={8} movement="down" />);
    expect(screen.getByRole("img", { name: /moved down/i })).toBeInTheDocument();
  });
});
