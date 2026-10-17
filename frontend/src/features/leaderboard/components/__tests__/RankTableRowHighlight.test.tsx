import React from "react";
import { render, screen } from "@testing-library/react";
import { RankTableRow } from "../RankTableRow";
import { LeaderboardTable } from "../LeaderboardTable";
import { formatAgentId, formatCurrency } from "../../utils/format";
import type { Survivor } from "../../types";

const survivor: Survivor = {
  id: "1",
  agentId: "GABCDEF1234567890WXYZ",
  rank: 4,
  survivalStreak: 5,
  totalYield: 100,
  arenasWon: 1,
};

describe("RankTableRow highlight (#1567)", () => {
  it("highlights the connected wallet's own row", () => {
    const { container } = render(
      <table>
        <tbody>
          <RankTableRow survivor={survivor} isHighlighted />
        </tbody>
      </table>,
    );
    const row = container.querySelector("tr");
    expect(row?.getAttribute("aria-current")).toBe("true");
  });

  it("does not highlight other rows", () => {
    const { container } = render(
      <table>
        <tbody>
          <RankTableRow survivor={survivor} />
        </tbody>
      </table>,
    );
    expect(container.querySelector("tr")?.hasAttribute("aria-current")).toBe(false);
  });

  it("LeaderboardTable highlights the row matching highlightWallet (case-insensitive)", () => {
    const other: Survivor = { ...survivor, id: "2", agentId: "GOTHER9999ZZZZ", rank: 5 };
    const { container } = render(
      <LeaderboardTable
        survivors={[survivor, other]}
        highlightWallet={survivor.agentId.toLowerCase()}
      />,
    );
    const highlighted = container.querySelectorAll('tr[aria-current="true"]');
    expect(highlighted).toHaveLength(1);
    expect(screen.getByText(formatAgentId(survivor.agentId))).toBeInTheDocument();
  });
});

describe("leaderboard format utils (#1567)", () => {
  it("truncates long agent ids and leaves short ones intact", () => {
    expect(formatAgentId("GABCDEF1234567890WXYZ")).toBe("G...WXYZ");
    expect(formatAgentId("SHORT")).toBe("SHORT");
  });

  it("formats currency with 2 decimals", () => {
    expect(formatCurrency(750)).toBe("$750.00");
  });
});
