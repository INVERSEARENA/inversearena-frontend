// Tests for MetricsOverview component

import React from "react";
import { render, screen } from "@testing-library/react";
import { MetricsOverview } from "../components/MetricsOverview";
import type { AdminMetrics } from "../types";

describe("MetricsOverview", () => {
  const mockMetrics: AdminMetrics = {
    totalArenas: 100,
    activeArenas: 75,
    totalPlayers: 5000,
    activePlayers: 3000,
    totalVolume: 10_000_000,
    platformFees: 50_000,
  };

  it("should render all metrics", () => {
    render(<MetricsOverview metrics={mockMetrics} />);

    expect(screen.getByText("Total Arenas")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("75 active")).toBeInTheDocument();

    expect(screen.getByText("Total Players")).toBeInTheDocument();
    expect(screen.getByText("5000")).toBeInTheDocument();
    expect(screen.getByText("3000 active")).toBeInTheDocument();

    expect(screen.getByText("Platform Volume")).toBeInTheDocument();
    expect(screen.getByText("$10.00M")).toBeInTheDocument();

    expect(screen.getByText("Platform Fees")).toBeInTheDocument();
    expect(screen.getByText("$50.0K")).toBeInTheDocument();
  });

  it("should format large numbers correctly", () => {
    const largeMetrics: AdminMetrics = {
      totalArenas: 1000,
      activeArenas: 800,
      totalPlayers: 50000,
      activePlayers: 30000,
      totalVolume: 1_500_000_000,
      platformFees: 7_500_000,
    };

    render(<MetricsOverview metrics={largeMetrics} />);

    expect(screen.getByText("$1500.00M")).toBeInTheDocument();
    expect(screen.getByText("$7500.0K")).toBeInTheDocument();
  });
});
