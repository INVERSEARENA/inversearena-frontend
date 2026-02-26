"use client";

/* Match history data type for each arena entry */
type MatchEntry = {
  arenaId: string; // Truncated arena identifier (e.g., "0x4F2A...91A")
  date: string; // Date of the match in YYYY-MM-DD format
  rounds: number; // Number of rounds played in the match
  yield: string; // Yield earned from the match (e.g., "12.4 XLM")
  status: "SURVIVED" | "ELIMINATED"; // Final outcome status for the match
};

/* Static mock data representing historical match entries */
const mockMatches: MatchEntry[] = [
  {
    arenaId: "0x4F2A...91A", // First arena match identifier
    date: "2023-10-24", // Match date
    rounds: 18, // Rounds survived
    yield: "12.4 XLM", // Yield earned
    status: "SURVIVED", // Player survived this match
  },
  {
    arenaId: "0xBC11...E82", // Second arena match identifier
    date: "2023-10-23", // Match date
    rounds: 4, // Rounds survived before elimination
    yield: "0.12 XLM", // Yield earned
    status: "ELIMINATED", // Player was eliminated this match
  },
  {
    arenaId: "0x98FF...AA2", // Third arena match identifier
    date: "2023-10-22", // Match date
    rounds: 22, // Rounds survived
    yield: "24.5 XLM", // Yield earned
    status: "SURVIVED", // Player survived this match
  },
  {
    arenaId: "0xD421...9B0", // Fourth arena match identifier
    date: "2023-10-21", // Match date
    rounds: 8, // Rounds survived before elimination
    yield: "1.50 XLM", // Yield earned
    status: "ELIMINATED", // Player was eliminated this match
  },
  {
    arenaId: "0x76E2...C11", // Fifth arena match identifier
    date: "2023-10-20", // Match date
    rounds: 15, // Rounds survived
    yield: "8.22 XLM", // Yield earned
    status: "SURVIVED", // Player survived this match
  },
];

/* Column header labels for the history table */
const columns = ["ARENA_ID", "DATE", "ROUNDS", "YIELD", "FINAL_STATUS"] as const;

/* Props interface for the HistoryTable component */
interface HistoryTableProps {
  onSelectMatch: (index: number) => void; // Callback fired when a row is clicked, passing the match index
  selectedIndex: number; // Currently selected row index for visual highlighting
}

/* HistoryTable renders the scrollable match history data table with hover and selection states */
export function HistoryTable({ onSelectMatch, selectedIndex }: HistoryTableProps) {
  return (
    /* Outer wrapper with dark border and hidden overflow for table scroll */
    <div className="border-[3px] border-[#0F1B2D] bg-[#0A1324] overflow-hidden">
      {/* Inner container with horizontal scroll support for narrow viewports */}
      <div className="overflow-x-auto">
        {/* Full-width table with fixed layout and monospace font for data alignment */}
        <table className="w-full table-fixed font-mono text-[10px] md:text-[11px]">
          {/* Table header row with sticky positioning and bottom border */}
          <thead>
            <tr className="border-b border-[#152339]">
              {/* Map each column header with uppercase monospace styling */}
              {columns.map((col) => (
                <th
                  key={col} // Unique key from column name
                  className="px-3 py-3 text-left font-bold uppercase tracking-[0.16em] text-[#37FF1C] md:px-4"
                >
                  {col} {/* Render the column header label */}
                </th>
              ))}
            </tr>
          </thead>
          {/* Table body rendering each match row */}
          <tbody>
            {mockMatches.map((match, idx) => (
              <tr
                key={match.arenaId} // Unique key from arena identifier
                onClick={() => onSelectMatch(idx)} // Fire selection callback on row click
                role="button" // Indicate row is interactive for accessibility
                tabIndex={0} // Allow keyboard focus on the row
                onKeyDown={(e) => {
                  /* Allow Enter and Space keys to trigger row selection for accessibility */
                  if (e.key === "Enter" || e.key === " ") onSelectMatch(idx);
                }}
                className={[
                  /* Base row styles: bottom border, pointer cursor, and transition */
                  "border-b border-[#0F1B2D] cursor-pointer transition-colors",
                  /* Apply darker highlight background if this row is currently selected */
                  selectedIndex === idx
                    ? "bg-[#111D30]"
                    : "hover:bg-[#0D1829]", // Apply subtle hover background when not selected
                ].join(" ")}
              >
                {/* Arena ID cell with muted gray text */}
                <td className="px-3 py-3 text-[#9CA7BB] md:px-4">
                  {match.arenaId} {/* Truncated arena address */}
                </td>
                {/* Date cell with muted gray text */}
                <td className="px-3 py-3 text-[#9CA7BB] md:px-4">
                  {match.date} {/* Match date string */}
                </td>
                {/* Rounds cell centered with white text for emphasis */}
                <td className="px-3 py-3 text-center text-white md:px-4">
                  {String(match.rounds).padStart(2, "0")} {/* Zero-padded round count */}
                </td>
                {/* Yield cell with white text for emphasis */}
                <td className="px-3 py-3 text-white md:px-4">
                  {match.yield} {/* Yield amount with XLM unit */}
                </td>
                {/* Final status cell with a colored badge */}
                <td className="px-3 py-3 md:px-4">
                  {/* Status badge: green background for SURVIVED, red for ELIMINATED */}
                  <span
                    className={[
                      /* Base badge styles: inline-block, padding, tiny monospace font, bold uppercase */
                      "inline-block px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider",
                      /* Conditional coloring based on match outcome */
                      match.status === "SURVIVED"
                        ? "bg-[#37FF1C] text-black" // Neon green background, black text for survived
                        : "bg-[#FF3B3B] text-white", // Red background, white text for eliminated
                    ].join(" ")}
                  >
                    {match.status} {/* SURVIVED or ELIMINATED text */}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Footer row indicating end of log data with monospace ellipsis styling */}
      <div className="border-t border-[#0F1B2D] px-4 py-2 text-center font-mono text-[9px] tracking-[0.2em] text-[#3A4A60]">
        --- END OF LOG --- {/* Visual indicator that there are no more entries */}
      </div>
    </div>
  );
}
