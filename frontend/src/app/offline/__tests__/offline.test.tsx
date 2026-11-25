import React from "react";
import { render, screen } from "@testing-library/react";
import OfflinePage from "../page";

describe("OfflinePage (#691)", () => {
  it("communicates the offline state to the player", () => {
    render(<OfflinePage />);
    expect(screen.getByRole("heading", { name: /offline/i })).toBeInTheDocument();
    expect(screen.getByText(/can't reach the network/i)).toBeInTheDocument();
  });
});
