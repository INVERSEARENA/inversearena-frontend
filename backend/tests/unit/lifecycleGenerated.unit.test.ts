import { readFileSync } from "fs";
import { resolve } from "path";
import {
  ARENA_GAME_STATES,
  ARENA_GAME_TERMINAL_STATES,
  TRANSACTION_STATES,
  ROUND_STATES,
  canTransitionArenaGame,
  canTransitionRound,
  canTransitionTransaction,
  isArenaGameState,
  isRoundState,
  isTransactionState,
  parseRoundState,
  parseArenaGameState,
  parseTransactionState,
  type ArenaGameState,
  type RoundState,
  type TransactionState,
} from "../../src/domain/lifecycle/generated";

// Golden fixture generated from scripts/lifecycle/lifecycle-spec.json (#1693).
// Every ordered state pair per domain, with whether the spec allows it.
type FixtureDomain = { states: string[]; transitions: Array<[string, string, boolean]> };
const fixture: { domains: Record<string, FixtureDomain> } = JSON.parse(
  readFileSync(resolve(__dirname, "../contract-fixtures/lifecycle-transitions.json"), "utf8"),
);

const checkers: Record<string, (from: string, to: string) => boolean> = {
  round: (from, to) => canTransitionRound(from as RoundState, to as RoundState),
  arenaGame: (from, to) => canTransitionArenaGame(from as ArenaGameState, to as ArenaGameState),
  transaction: (from, to) => canTransitionTransaction(from as TransactionState, to as TransactionState),
};

describe("generated lifecycle transitions", () => {
  for (const [domain, data] of Object.entries(fixture.domains)) {
    it(`matches the golden fixture for ${domain}`, () => {
      const can = checkers[domain];
      for (const [from, to, legal] of data.transitions) {
        expect({ from, to, allowed: can(from, to) }).toEqual({ from, to, allowed: legal });
      }
    });
  }

  it("covers every ordered state pair in each fixture domain", () => {
    for (const data of Object.values(fixture.domains)) {
      expect(data.transitions).toHaveLength(data.states.length * data.states.length);
    }
  });
});

describe("generated lifecycle state parsers", () => {
  it("keeps wire values exactly as persisted or emitted today", () => {
    expect([...ROUND_STATES]).toEqual(["OPEN", "CLOSED", "RESOLVED", "SETTLED"]);
    expect([...ARENA_GAME_STATES]).toEqual(["Open", "Active", "Finished", "Cancelled", "Settled"]);
    expect([...TRANSACTION_STATES]).toEqual(["submitted", "confirmed", "failed", "dead", "unknown"]);
  });

  it("reports legacy and unknown values without throwing", () => {
    expect(parseRoundState("OPEN")).toEqual({ kind: "known", state: "OPEN" });
    expect(parseRoundState("open")).toEqual({ kind: "unknown", raw: "open" });
    expect(parseArenaGameState("InProgress")).toEqual({ kind: "unknown", raw: "InProgress" });
    expect(parseTransactionState("pending")).toEqual({ kind: "unknown", raw: "pending" });
  });

  it("type guards reject values outside the spec", () => {
    expect(isRoundState("SETTLED")).toBe(true);
    expect(isRoundState("")).toBe(false);
    expect(isArenaGameState("Settled")).toBe(true);
    expect(isArenaGameState("InProgress")).toBe(false);
    expect(isTransactionState("confirmed")).toBe(true);
    expect(isTransactionState("CONFIRMED")).toBe(false);
  });

  it("terminal arena states allow no outgoing transitions", () => {
    for (const terminal of ARENA_GAME_TERMINAL_STATES) {
      for (const to of ARENA_GAME_STATES) {
        expect(canTransitionArenaGame(terminal, to)).toBe(false);
      }
    }
  });
});
