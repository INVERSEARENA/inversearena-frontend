"use client";

/* Type representing a single round entry with choice and outcome */
type RoundEntry = {
  round: number; // The round number (e.g., 1, 2, 3)
  choice: "HEADS" | "TAILS"; // The player's choice in this round
  outcome: string; // The result label (e.g., "[MINOR_WIN]", "[MAJORITY_LOSS]")
  isLoss: boolean; // Whether this round resulted in a loss (used for red border highlight)
};

/* Type representing a full match's round-by-round log data */
type MatchRoundData = {
  arenaId: string; // The truncated arena identifier this log belongs to
  rounds: RoundEntry[]; // Array of individual round entries
};

/* Static mock data for each selectable match's round-by-round log */
const mockRoundData: MatchRoundData[] = [
  {
    arenaId: "0x4F2A...91A", // First match arena identifier
    rounds: [
      { round: 1, choice: "HEADS", outcome: "[MINOR_WIN]", isLoss: false }, // Round 1: win
      { round: 2, choice: "TAILS", outcome: "[MINOR_WIN]", isLoss: false }, // Round 2: win
      { round: 3, choice: "HEADS", outcome: "[MAJORITY_LOSS]", isLoss: true }, // Round 3: loss (red border)
      { round: 4, choice: "TAILS", outcome: "[MINOR_WIN]", isLoss: false }, // Round 4: win
      { round: 5, choice: "TAILS", outcome: "[MINOR_WIN]", isLoss: false }, // Round 5: win
    ],
  },
  {
    arenaId: "0xBC11...E82", // Second match arena identifier
    rounds: [
      { round: 1, choice: "TAILS", outcome: "[MINOR_WIN]", isLoss: false }, // Round 1: win
      { round: 2, choice: "HEADS", outcome: "[MAJORITY_LOSS]", isLoss: true }, // Round 2: loss (red border)
      { round: 3, choice: "HEADS", outcome: "[MINOR_WIN]", isLoss: false }, // Round 3: win
      { round: 4, choice: "TAILS", outcome: "[MAJORITY_LOSS]", isLoss: true }, // Round 4: loss (eliminated)
    ],
  },
  {
    arenaId: "0x98FF...AA2", // Third match arena identifier
    rounds: [
      { round: 1, choice: "HEADS", outcome: "[MINOR_WIN]", isLoss: false }, // Round 1: win
      { round: 2, choice: "HEADS", outcome: "[MINOR_WIN]", isLoss: false }, // Round 2: win
      { round: 3, choice: "TAILS", outcome: "[MINOR_WIN]", isLoss: false }, // Round 3: win
      { round: 4, choice: "HEADS", outcome: "[MAJORITY_LOSS]", isLoss: true }, // Round 4: loss (red border)
      { round: 5, choice: "TAILS", outcome: "[MINOR_WIN]", isLoss: false }, // Round 5: win
    ],
  },
  {
    arenaId: "0xD421...9B0", // Fourth match arena identifier
    rounds: [
      { round: 1, choice: "TAILS", outcome: "[MINOR_WIN]", isLoss: false }, // Round 1: win
      { round: 2, choice: "HEADS", outcome: "[MINOR_WIN]", isLoss: false }, // Round 2: win
      { round: 3, choice: "TAILS", outcome: "[MAJORITY_LOSS]", isLoss: true }, // Round 3: loss (eliminated)
    ],
  },
  {
    arenaId: "0x76E2...C11", // Fifth match arena identifier
    rounds: [
      { round: 1, choice: "HEADS", outcome: "[MINOR_WIN]", isLoss: false }, // Round 1: win
      { round: 2, choice: "TAILS", outcome: "[MINOR_WIN]", isLoss: false }, // Round 2: win
      { round: 3, choice: "HEADS", outcome: "[MINOR_WIN]", isLoss: false }, // Round 3: win
      { round: 4, choice: "TAILS", outcome: "[MINOR_WIN]", isLoss: false }, // Round 4: win
      { round: 5, choice: "HEADS", outcome: "[MAJORITY_LOSS]", isLoss: true }, // Round 5: loss (red border)
    ],
  },
];

/* Props for the RoundLogPanel accepting the currently selected match index */
interface RoundLogPanelProps {
  selectedIndex: number; // Index into mockRoundData to display the correct match log
}

/* RoundLogPanel renders the round-by-round detail side panel for a selected arena match */
export function RoundLogPanel({ selectedIndex }: RoundLogPanelProps) {
  /* Look up the round data for the selected match, fallback to first entry */
  const data = mockRoundData[selectedIndex] ?? mockRoundData[0];

  return (
    /* Outer container with dark border and background matching the archives design system */
    <div className="border-[3px] border-[#0F1B2D] bg-[#0A1324] flex flex-col">
      {/* Panel header row with title and a refresh icon button */}
      <div className="flex items-center justify-between border-b border-[#152339] px-4 py-3">
        {/* Panel title in bold uppercase monospace, matching the neubrutalist style */}
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-white">
          ROUND_BY_ROUND {/* Panel heading text */}
        </h3>
        {/* Refresh/reload icon button for the panel */}
        <button
          type="button" // Explicitly non-submit button
          className="flex size-7 items-center justify-center border border-[#2B3A52] bg-[#121C2C] text-[#9CA7BB] transition-colors hover:border-[#4B5B76]"
          aria-label="Refresh round data" // Accessible label for screen readers
        >
          {/* Inline SVG refresh icon (circular arrows) */}
          <svg
            xmlns="http://www.w3.org/2000/svg" // SVG namespace
            width="12" // Icon width in pixels
            height="12" // Icon height in pixels
            viewBox="0 0 24 24" // SVG coordinate system
            fill="none" // No fill for stroke-only icon
            stroke="currentColor" // Use current text color for stroke
            strokeWidth="2.5" // Thicker stroke for bold appearance
            strokeLinecap="round" // Rounded line caps
            strokeLinejoin="round" // Rounded line joins
            aria-hidden="true" // Hide decorative SVG from screen readers
          >
            {/* First arc path of the refresh icon */}
            <path d="M21 2v6h-6" />
            {/* Curved arrow path forming the refresh circle */}
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
            {/* Second arc path of the refresh icon */}
            <path d="M3 22v-6h6" />
            {/* Second curved arrow path completing the refresh circle */}
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          </svg>
        </button>
      </div>

      {/* Scrollable list of individual round entries */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {data.rounds.map((entry) => (
          /* Individual round row with conditional red left border for loss rounds */
          <div
            key={`round-${entry.round}`} // Unique key combining "round-" prefix and round number
            className={[
              /* Base styles: flex layout, padding, and left border */
              "flex items-center justify-between px-3 py-2.5 border-l-[3px]",
              /* Apply red border and background tint for loss rounds, transparent border otherwise */
              entry.isLoss
                ? "border-l-[#FF3B3B] bg-[#1A0F0F]" // Red left border and subtle red background for losses
                : "border-l-transparent bg-[#0D1829]", // Transparent border and dark background for wins
            ].join(" ")}
          >
            {/* Left side: round number and choice label */}
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#9CA7BB]">
              {/* Round label formatted as "R1: HEADS" */}
              R{entry.round}: {entry.choice}
            </span>
            {/* Right side: outcome badge with conditional coloring */}
            <span
              className={[
                /* Base badge styles: monospace, tiny font, bold */
                "font-mono text-[10px] font-bold uppercase tracking-[0.08em]",
                /* Red text for loss outcomes, green text for win outcomes */
                entry.isLoss ? "text-[#FF3B3B]" : "text-[#37FF1C]",
              ].join(" ")}
            >
              {entry.outcome} {/* Outcome label like [MINOR_WIN] or [MAJORITY_LOSS] */}
            </span>
          </div>
        ))}
      </div>

      {/* Footer row indicating end of the round log with monospace ellipsis styling */}
      <div className="border-t border-[#0F1B2D] px-4 py-2 text-center font-mono text-[9px] tracking-[0.2em] text-[#3A4A60]">
        --- END OF LOG --- {/* Visual indicator for end of round data */}
      </div>
    </div>
  );
}