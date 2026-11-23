// Tests for ArenaManagementPanel component

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ArenaManagementPanel } from "../components/ArenaManagementPanel";
import type { ArenaConfig } from "../types";

describe("ArenaManagementPanel", () => {
  const mockArenas: ArenaConfig[] = [
    {
      id: "arena-1",
      name: "Test Arena 1",
      status: "active",
      entryFee: 100,
      maxPlayers: 50,
      currentPlayers: 25,
      joinDeadline: new Date("2026-12-31"),
      createdAt: new Date("2026-01-01"),
    },
    {
      id: "arena-2",
      name: "Test Arena 2",
      status: "paused",
      entryFee: 200,
      maxPlayers: 100,
      currentPlayers: 0,
      joinDeadline: new Date("2026-12-31"),
      createdAt: new Date("2026-01-01"),
    },
  ];

  const mockUpdateArena = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should render all arenas", () => {
    render(
      <ArenaManagementPanel arenas={mockArenas} onUpdateArena={mockUpdateArena} />
    );

    expect(screen.getByText("Test Arena 1")).toBeInTheDocument();
    expect(screen.getByText("Test Arena 2")).toBeInTheDocument();
    expect(screen.getByText("25 / 50")).toBeInTheDocument();
    expect(screen.getByText("0 / 100")).toBeInTheDocument();
  });

  it("should display correct status badges", () => {
    render(
      <ArenaManagementPanel arenas={mockArenas} onUpdateArena={mockUpdateArena} />
    );

    const statusBadges = screen.getAllByText(/active|paused/);
    expect(statusBadges).toHaveLength(2);
  });

  it("should call onUpdateArena when status toggle is clicked", async () => {
    mockUpdateArena.mockResolvedValue(undefined);

    render(
      <ArenaManagementPanel arenas={mockArenas} onUpdateArena={mockUpdateArena} />
    );

    const pauseButton = screen.getAllByText("Pause")[0];
    fireEvent.click(pauseButton);

    await waitFor(() => {
      expect(mockUpdateArena).toHaveBeenCalledWith("arena-1", { status: "paused" });
    });
  });

  it("should show activate button for paused arenas", () => {
    render(
      <ArenaManagementPanel arenas={mockArenas} onUpdateArena={mockUpdateArena} />
    );

    expect(screen.getByText("Activate")).toBeInTheDocument();
  });
});
